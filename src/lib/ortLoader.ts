/**
 * onnxruntime-web's WebGPU execution provider has options its JavaScript API cannot set: the EP
 * parses its configuration the moment it is appended to the session options, before
 * `session_options.extra` is applied, and the API only forwards a short allow-list of EP keys.
 * The loader of the WebAssembly runtime is the one hook left: `env.wasm.wasmPaths.mjs` names the
 * module onnxruntime-web imports for its Emscripten factory. This builds a blob module that wraps the
 * real loader and adds the entries below to every session that appends the WebGPU provider, right
 * before the provider parses them.
 */

/**
 * Nodes of the patched GLM-OCR decoder (scripts/patch-glm-graphs.py) that turn a Shape into an
 * input a kernel reads on the CPU: GroupQueryAttention's total_sequence_length and Expand's shape.
 * With int64 kernels available the provider would run these few integer ops on the GPU and copy
 * the results back every token; its own fallback heuristic marks them but does not survive
 * partitioning. Pinned by name instead. The patch script checks this list against the graph.
 */
const GLM_CPU_NODES = [
  '/lengths/batch/Gather',
  '/lengths/sequence/Gather',
  '/lengths/past/Gather',
  '/lengths/total/Add',
  '/lengths/total/Cast',
  '/lengths/expand_shape/Concat',
];

/** Keys from onnxruntime/core/providers/webgpu/webgpu_provider_options.h. */
const WEBGPU_EP_CONFIG: Record<string, string> = {
  // int64 kernels. Without them every int64 tensor is computed on the CPU and uploaded, each upload
  // flushing a command buffer; the patched GLM-OCR decoder derives its GroupQueryAttention lengths
  // and M-RoPE positions from int64 inputs that already live on the GPU, so a decode step uploads
  // nothing.
  'ep.webgpuexecutionprovider.enableInt64': '1',
  'ep.webgpuexecutionprovider.forceCpuNodeNames': GLM_CPU_NODES.join('\n'),
  // A command buffer is submitted every 16 dispatches by default; a GLM-OCR decoder pass is a few
  // hundred, and every submit is a scheduling gap on the GPU. One submit per pass.
  'ep.webgpuexecutionprovider.maxNumPendingDispatches': '1024',
};

/** A blob URL for the wrapping loader; `realLoaderUrl` is the runtime's own `.mjs` next to its `.wasm`. */
export function webgpuLoaderUrl(realLoaderUrl: string): string {
  const source = `
const CONFIG = ${JSON.stringify(WEBGPU_EP_CONFIG)};
export default async function (moduleArgs) {
  // Runtime-selected specifier: the real loader lives under a versioned path only known at run time.
  const module = await (await import(${JSON.stringify(realLoaderUrl)})).default(moduleArgs);
  const cString = text => {
    const bytes = module.lengthBytesUTF8(text) + 1;
    const pointer = module._malloc(bytes);
    module.stringToUTF8(text, pointer, bytes);
    return pointer;
  };
  const append = module._OrtAppendExecutionProvider;
  module._OrtAppendExecutionProvider = (sessionOptions, name, keys, values, count) => {
    if (module.UTF8ToString(name) === 'WebGPU') {
      for (const [key, value] of Object.entries(CONFIG)) {
        const keyPointer = cString(key);
        const valuePointer = cString(value);
        const status = module._OrtAddSessionConfigEntry(sessionOptions, keyPointer, valuePointer);
        module._free(keyPointer);
        module._free(valuePointer);
        if (status !== 0) return status;
      }
    }
    return append(sessionOptions, name, keys, values, count);
  };
  return module;
}
`;
  return URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
}
