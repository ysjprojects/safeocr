#!/usr/bin/env python3
"""
Produces public/models/glm-ocr/<tag>/ from upstream's GLM-OCR ONNX export (onnx-community/GLM-OCR-ONNX):

  vision_encoder_q4f16.onnx        upstream's vision graph with the attention mask removed from its
                                   MultiHeadAttention nodes. The export builds a dense [1, 1, patches,
                                   patches] bias so that several images in one batch cannot see each
                                   other; the app sends one image, for which it is all zeros, yet it
                                   cost a patches² allocation and one extra load per attention score.
  decoder_model_merged_q4f16.onnx  upstream's decoder graph reworked for src/lib/engines/decode.ts,
                                   which drives it with GPU-resident inputs and never waits for a
                                   readback. A decode step is then three command buffers and no
                                   copy in either direction, and a third fewer kernels:
                                   - `next_token`, the argmax of the logits, is an extra output;
                                   - GroupQueryAttention loses its attention_bias: the export builds
                                     a (1 - mask) * -65504 bias for padded batches, which is all
                                     zeros for the app's single unpadded sequence while GQA is
                                     causal on its own;
                                   - every RotaryEmbedding reads its positions from one shared [0]
                                     offset (the kernel adds the token index) instead of a per-layer
                                     Range(0, tokens) that onnxruntime computed on the CPU and
                                     uploaded, with a command-buffer flush, 32 times per token; it
                                     runs in fp16 on the [batch, tokens, hidden] layout, dropping the
                                     Cast and Transpose pairs around it, and the 64 RMS norms run in
                                     fp16 too (the kernel sums in fp32 whatever the input type);
                                   - seqlens_k for GQA is ReduceSum(attention_mask) - 1 on the GPU;
                                     total_sequence_length and the M-RoPE batch size come from
                                     Shape of inputs_embeds and of the first past key, float tensors
                                     the WebGPU Shape kernel accepts, so the int64 inputs have GPU
                                     consumers only (a graph input read by both providers gets a
                                     copy node that drags a GPU feed through the CPU every step);
                                   - the num_logits_to_keep input is gone, the head slice keeps the
                                     last position (the only value the app ever passed).
                                   Requires the int64 kernels and the CPU pins that
                                   src/lib/ortLoader.ts sets on the WebGPU provider.

Only the graphs change; every weight they reference still comes from the Hub, so the output is tied
to the upstream revision below. The worker checks the weights' sizes against GLM_FILE_BYTES before
using the patched graphs (src/lib/engines/glm.ts).

    pip install onnx
    python3 scripts/patch-glm-graphs.py [--decoder decoder_model_merged_q4f16.onnx] [--vision vision_encoder_q4f16.onnx]

Without local copies the upstream graphs are fetched with curl at the pinned revision.
"""
import argparse
import pathlib
import subprocess
import sys

import onnx
from onnx import TensorProto, helper, numpy_helper

ONNX_REPO = "onnx-community/GLM-OCR-ONNX"
ONNX_REVISION = "aea46198f09e3aa2b63422dd234f1cc66afffe52"  # main on 2026-10-06
TAG = ONNX_REVISION[:8] + "-7"  # bump the suffix whenever the patched graphs change: the files are served immutable


# Mirrors GLM_CPU_NODES in src/lib/ortLoader.ts.
CPU_NODES = {
    "/lengths/batch/Gather",
    "/lengths/sequence/Gather",
    "/lengths/past/Gather",
    "/lengths/total/Add",
    "/lengths/total/Cast",
    "/lengths/expand_shape/Concat",
}
root = pathlib.Path(__file__).resolve().parent.parent
out_dir = root / "public" / "models" / "glm-ocr" / TAG


def upstream(name: str, local: str | None) -> onnx.ModelProto:
    if local:
        return onnx.load(local, load_external_data=False)
    url = f"https://huggingface.co/{ONNX_REPO}/resolve/{ONNX_REVISION}/onnx/{name}"
    print(f"fetching {url}")
    return onnx.load_from_string(subprocess.run(["curl", "-sfL", url], check=True, capture_output=True).stdout)


def dead_code_eliminate(graph: onnx.GraphProto) -> None:
    outputs = {o.name for o in graph.output}
    while True:
        consumed = {name for n in graph.node for name in n.input}
        dead = [n for n in graph.node if not any(o in consumed or o in outputs for o in n.output)]
        if not dead:
            break
        for n in dead:
            graph.node.remove(n)
    used = {name for n in graph.node for name in n.input}
    for init in [i for i in graph.initializer if i.name not in used]:
        graph.initializer.remove(init)


def topological_sort(graph: onnx.GraphProto) -> None:
    """Appended nodes feed earlier ones; ONNX wants the node list in dependency order."""
    available = {i.name for i in graph.input} | {i.name for i in graph.initializer} | {""}
    pending = list(graph.node)
    ordered = []
    while pending:
        ready = [n for n in pending if all(name in available for name in n.input)]
        if not ready:
            sys.exit("graph: a node reads a value nothing produces")
        for n in ready:
            available.update(n.output)
            ordered.append(n)
        pending = [n for n in pending if n not in ready]
    del graph.node[:]
    graph.node.extend(ordered)


def patch_vision(model: onnx.ModelProto) -> None:
    graph = model.graph
    mha = [n for n in graph.node if n.op_type == "MultiHeadAttention"]
    if not mha:
        sys.exit("vision graph: no MultiHeadAttention nodes")
    for node in mha:
        if len(node.input) <= 5 or not node.input[5] or any(node.input[i] for i in range(6, len(node.input))):
            sys.exit(f"{node.name}: the upstream vision graph has changed")
        del node.input[3:]  # bias, key_padding_mask (both empty) and attention_bias
    before = len(graph.node)
    dead_code_eliminate(graph)
    print(f"vision: {len(mha)} MultiHeadAttention nodes unmasked, {before} → {len(graph.node)} nodes")


def patch_decoder(model: onnx.ModelProto) -> None:
    graph = model.graph
    if not any(o.name == "logits" for o in graph.output):
        sys.exit("decoder graph: no logits output")
    graph.node.append(helper.make_node("ArgMax", ["logits"], ["next_token"], name="/next_token", axis=-1, keepdims=0))
    graph.output.append(helper.make_tensor_value_info("next_token", TensorProto.INT64, ["batch_size", "num_logits_to_keep"]))

    # GroupQueryAttention inputs: query, key, value, past_key, past_value, seqlens_k,
    # total_sequence_length, cos_cache, sin_cache, position_ids, attention_bias.
    gqa = [n for n in graph.node if n.op_type == "GroupQueryAttention"]
    if not gqa:
        sys.exit("decoder graph: no GroupQueryAttention nodes")
    for node in gqa:
        if len(node.input) != 11 or any(node.input[i] for i in (7, 8, 9)) or not node.input[10]:
            sys.exit(f"{node.name}: the upstream decoder graph has changed")
        del node.input[7:]

    producer = {o: n for n in graph.node for o in n.output}
    consumers: dict[str, list[onnx.NodeProto]] = {}
    for n in graph.node:
        for name in n.input:
            consumers.setdefault(name, []).append(n)
    initializers = {t.name: t for t in graph.initializer}

    def attribute(node: onnx.NodeProto, name: str):
        return next(helper.get_attribute_value(a) for a in node.attribute if a.name == name)

    def only_consumer(name: str, op_type: str) -> onnx.NodeProto:
        nodes = consumers.get(name, [])
        if len(nodes) != 1 or nodes[0].op_type != op_type:
            sys.exit(f"decoder graph: expected one {op_type} after {name}")
        return nodes[0]

    def producer_of(name: str, op_type: str) -> onnx.NodeProto:
        node = producer.get(name)
        if node is None or node.op_type != op_type:
            sys.exit(f"decoder graph: expected a {op_type} before {name}")
        return node

    # The export runs every RMS norm in fp32 between two Casts. onnxruntime's WebGPU norm sums in
    # fp32 whatever the input type, so the fp16 residual stream goes in directly; the fp32 scale is
    # cast once at session creation (constant folding).
    norms = [n for n in graph.node if n.op_type == "SimplifiedLayerNormalization"]
    if not norms:
        sys.exit("decoder graph: no SimplifiedLayerNormalization nodes")
    for node in norms:
        cast_in = producer_of(node.input[0], "Cast")
        cast_out = only_consumer(node.output[0], "Cast")
        if attribute(cast_in, "to") != TensorProto.FLOAT or attribute(cast_out, "to") != TensorProto.FLOAT16:
            sys.exit(f"{node.name}: the upstream decoder graph has changed")
        scale = node.input[1]
        graph.node.append(helper.make_node("Cast", [scale], [f"{scale}/fp16"], name=f"{node.name}/scale/Cast", to=TensorProto.FLOAT16))
        node.input[0] = cast_in.input[0]
        node.input[1] = f"{scale}/fp16"
        node.output[0] = cast_out.output[0]
        graph.node.remove(cast_out)

    # Rotary embeddings likewise ran in fp32, on heads split out by a Transpose on each side; the
    # kernel takes [batch, tokens, heads * head_size] directly given num_heads, and fp16. All 32
    # nodes read one shared [0] position offset (the kernel adds the token index) instead of a
    # per-layer Range(0, tokens) that onnxruntime computed on the CPU and uploaded 32 times a token.
    rotary = [n for n in graph.node if n.op_type == "RotaryEmbedding"]
    if not rotary:
        sys.exit("decoder graph: no RotaryEmbedding nodes")
    graph.initializer.append(helper.make_tensor("/rotary_position_offset", TensorProto.INT64, [1], [0]))
    caches = {rotary[0].input[2], rotary[0].input[3]}
    for name in sorted(caches):
        graph.node.append(helper.make_node("Cast", [name], [f"{name}/fp16"], name=f"{name}/Cast", to=TensorProto.FLOAT16))
    for node in rotary:
        if {node.input[2], node.input[3]} != caches:
            sys.exit(f"{node.name}: the upstream decoder graph has changed")
        cast_in = producer_of(node.input[0], "Cast")
        transpose_in = producer_of(cast_in.input[0], "Transpose")
        reshape_in = producer_of(transpose_in.input[0], "Reshape")
        cast_out = only_consumer(node.output[0], "Cast")
        transpose_out = only_consumer(cast_out.output[0], "Transpose")
        reshape_out = only_consumer(transpose_out.output[0], "Reshape")
        heads = numpy_helper.to_array(initializers[reshape_in.input[1]])
        if list(attribute(transpose_in, "perm")) != [0, 2, 1, 3] or len(heads) != 4 or heads[3] != attribute(node, "rotary_embedding_dim"):
            sys.exit(f"{node.name}: the upstream decoder graph has changed")
        node.input[0] = reshape_in.input[0]
        node.input[1] = "/rotary_position_offset"
        node.input[2] = f"{node.input[2]}/fp16"
        node.input[3] = f"{node.input[3]}/fp16"
        node.output[0] = reshape_out.output[0]
        for attr in list(node.attribute):
            if attr.name == "num_heads":
                node.attribute.remove(attr)
        node.attribute.append(helper.make_attribute("num_heads", int(heads[2])))
        for dead in (cast_out, transpose_out, reshape_out):
            graph.node.remove(dead)

    # seqlens_k (a GPU input of GroupQueryAttention) comes from the mask's values on the GPU;
    # total_sequence_length (a CPU input) and the batch size for the M-RoPE inverse-frequency table
    # come from Shape, which only has a WebGPU kernel for float tensors: `inputs_embeds` and the
    # first past key. Shape of an int64 input would run on the CPU EP, and an input consumed by both
    # providers gets a copy node that drags a GPU-resident feed through the CPU every step.
    graph.initializer.extend(
        [
            helper.make_tensor("/seqlens_k/axes", TensorProto.INT64, [1], [1]),
            helper.make_tensor("/seqlens_k/one", TensorProto.INT64, [], [1]),
            helper.make_tensor("/lengths/zero", TensorProto.INT64, [1], [0]),  # rank 1: the batch feeds a Concat
            helper.make_tensor("/lengths/one", TensorProto.INT64, [], [1]),
            helper.make_tensor("/lengths/two", TensorProto.INT64, [], [2]),
        ]
    )
    graph.node.extend(
        [
            helper.make_node("ReduceSum", ["attention_mask", "/seqlens_k/axes"], ["/seqlens_k/sum"], name="/seqlens_k/ReduceSum", keepdims=0),
            helper.make_node("Sub", ["/seqlens_k/sum", "/seqlens_k/one"], ["/seqlens_k/sub"], name="/seqlens_k/Sub"),
            helper.make_node("Cast", ["/seqlens_k/sub"], ["/seqlens_k"], name="/seqlens_k/Cast", to=TensorProto.INT32),
            helper.make_node("Shape", ["inputs_embeds"], ["/lengths/embeds_shape"], name="/lengths/embeds/Shape"),
            helper.make_node("Shape", ["past_key_values.0.key"], ["/lengths/past_shape"], name="/lengths/past/Shape"),
            helper.make_node("Gather", ["/lengths/embeds_shape", "/lengths/zero"], ["/lengths/batch"], name="/lengths/batch/Gather", axis=0),
            helper.make_node("Gather", ["/lengths/embeds_shape", "/lengths/one"], ["/lengths/sequence"], name="/lengths/sequence/Gather", axis=0),
            helper.make_node("Gather", ["/lengths/past_shape", "/lengths/two"], ["/lengths/past"], name="/lengths/past/Gather", axis=0),
            helper.make_node("Add", ["/lengths/past", "/lengths/sequence"], ["/lengths/total"], name="/lengths/total/Add"),
            helper.make_node("Cast", ["/lengths/total"], ["/lengths/total_int32"], name="/lengths/total/Cast", to=TensorProto.INT32),
        ]
    )
    for node in gqa:
        node.input[5] = "/seqlens_k"
        node.input[6] = "/lengths/total_int32"
    batch_dim = [n for n in graph.node if n.name == "/model/mrope_dynamic_cache/pos_ids/Gather_1"]
    if len(batch_dim) != 1:
        sys.exit("decoder graph: the M-RoPE batch dimension has moved")
    for node in graph.node:
        for i, name in enumerate(node.input):
            if name == batch_dim[0].output[0]:
                node.input[i] = "/lengths/batch"
    # The nodes from Shape to a CPU-side kernel input; onnxruntime-web pins them to the CPU by name
    # (src/lib/ortLoader.ts), as its own fallback heuristic does not survive partitioning and a GPU
    # copy of these few integers would be read back every token.
    expand_shape = [n for n in graph.node if n.name == "/model/mrope_dynamic_cache/expand_shape/Concat"]
    if len(expand_shape) != 1:
        sys.exit("decoder graph: the M-RoPE expand shape has moved")
    expand_shape[0].name = "/lengths/expand_shape/Concat"
    cpu_nodes = {n.name for n in graph.node if n.name.startswith("/lengths/") and n.op_type != "Shape"}
    if cpu_nodes != CPU_NODES:
        sys.exit(f"decoder graph: CPU-side nodes are {sorted(cpu_nodes)}; src/lib/ortLoader.ts expects {sorted(CPU_NODES)}")

    keep = [i for i, inp in enumerate(graph.input) if inp.name == "num_logits_to_keep"]
    if len(keep) != 1:
        sys.exit("decoder graph: no num_logits_to_keep input")
    del graph.input[keep[0]]
    head = [n for n in graph.node if n.op_type == "Slice" and n.name == "/lm_head/num_logits_to_keep/Slice"]
    if len(head) != 1:
        sys.exit("decoder graph: the head slice has moved")
    graph.initializer.append(helper.make_tensor("/lm_head/last", TensorProto.INT64, [1], [-1]))
    head[0].input[1] = "/lm_head/last"

    before = len(graph.node)
    dead_code_eliminate(graph)
    topological_sort(graph)
    print(
        f"decoder: next_token output, {len(gqa)} GroupQueryAttention nodes without attention_bias, "
        f"{len(rotary)} RotaryEmbedding nodes on a shared position offset, {before} → {len(graph.node)} nodes"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--decoder", help="local copy of upstream's decoder_model_merged_q4f16.onnx")
    parser.add_argument("--vision", help="local copy of upstream's vision_encoder_q4f16.onnx")
    args = parser.parse_args()
    out_dir.mkdir(parents=True, exist_ok=True)

    vision = upstream("vision_encoder_q4f16.onnx", args.vision)
    patch_vision(vision)
    onnx.save(vision, str(out_dir / "vision_encoder_q4f16.onnx"))

    decoder = upstream("decoder_model_merged_q4f16.onnx", args.decoder)
    patch_decoder(decoder)
    onnx.save(decoder, str(out_dir / "decoder_model_merged_q4f16.onnx"))

    for path in sorted(out_dir.iterdir()):
        print(f"  {path.relative_to(root)}  {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
