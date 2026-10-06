export interface DiffOp {
  kind: 'equal' | 'insert' | 'delete';
  text: string;
}

/** Maximal runs of non-whitespace and of whitespace; every character lands in exactly one token. */
const TOKEN = /\S+|\s+/g;

/**
 * Word-level diff of `base` against `other`: tokens are maximal runs of non-whitespace and runs of
 * whitespace, so the ops concatenate back to the originals (equal+delete → base, equal+insert → other).
 *
 * Linear-space Myers (middle snake, O((N+M)·D) time, O(N+M) memory): a 5k-token OCR page with a few
 * dozen edits is a few hundred thousand comparisons, and even wholly different pages stay bounded.
 * Adjacent ops of one kind are merged and each change hunk lists its delete before its insert.
 */
export function diffWords(base: string, other: string): DiffOp[] {
  const aTokens = base.match(TOKEN) ?? [];
  const bTokens = other.match(TOKEN) ?? [];
  const ids = new Map<string, number>();
  const a = intern(aTokens, ids);
  const b = intern(bTokens, ids);
  const n = a.length;
  const m = b.length;

  const ops: DiffOp[] = [];
  let equal = '';
  let deleted = '';
  let inserted = '';
  const flushChange = () => {
    if (deleted !== '') ops.push({kind: 'delete', text: deleted});
    if (inserted !== '') ops.push({kind: 'insert', text: inserted});
    deleted = '';
    inserted = '';
  };
  const flushEqual = () => {
    if (equal === '') return;
    ops.push({kind: 'equal', text: equal});
    equal = '';
  };
  const emitEqual = (x0: number, x1: number) => {
    if (x0 === x1) return;
    flushChange();
    for (let i = x0; i < x1; i++) equal += aTokens[i];
  };
  const emitDelete = (x0: number, x1: number) => {
    if (x0 === x1) return;
    flushEqual();
    for (let i = x0; i < x1; i++) deleted += aTokens[i];
  };
  const emitInsert = (y0: number, y1: number) => {
    if (y0 === y1) return;
    flushEqual();
    for (let i = y0; i < y1; i++) inserted += bTokens[i];
  };

  // Furthest-reaching x (forward) / y (backward) per diagonal, indexed by diagonal + offset. Myers only
  // reads cells written by the previous step, so they never need clearing between boxes.
  const offset = n + m + 1;
  const vf = new Int32Array(2 * offset + 1);
  const vb = new Int32Array(2 * offset + 1);
  // Middle snake of the last `midpoint` call: (sx, sy) → (fx, fy) holds at most one edit step.
  let sx = 0;
  let sy = 0;
  let fx = 0;
  let fy = 0;

  const midpoint = (left: number, top: number, right: number, bottom: number) => {
    const delta = right - left - (bottom - top);
    const odd = (delta & 1) !== 0;
    const max = (right - left + bottom - top + 1) >> 1;
    vf[offset + 1] = left;
    vb[offset + 1] = bottom;
    for (let d = 0; d <= max; d++) {
      for (let k = d; k >= -d; k -= 2) {
        let px: number;
        let x: number;
        if (k === -d || (k !== d && vf[offset + k - 1] < vf[offset + k + 1])) {
          px = x = vf[offset + k + 1];
        } else {
          px = vf[offset + k - 1];
          x = px + 1;
        }
        let y = top + (x - left) - k;
        const py = d === 0 || x !== px ? y : y - 1;
        while (x < right && y < bottom && a[x] === b[y]) {
          x++;
          y++;
        }
        vf[offset + k] = x;
        const c = k - delta;
        if (odd && c > -d && c < d && y >= vb[offset + c]) {
          sx = px;
          sy = py;
          fx = x;
          fy = y;
          return;
        }
      }
      for (let c = d; c >= -d; c -= 2) {
        let py: number;
        let y: number;
        if (c === -d || (c !== d && vb[offset + c - 1] > vb[offset + c + 1])) {
          py = y = vb[offset + c + 1];
        } else {
          py = vb[offset + c - 1];
          y = py - 1;
        }
        const k = c + delta;
        let x = left + (y - top) + k;
        const px = d === 0 || y !== py ? x : x + 1;
        while (x > left && y > top && a[x - 1] === b[y - 1]) {
          x--;
          y--;
        }
        vb[offset + c] = y;
        if (!odd && k >= -d && k <= d && x <= vf[offset + k]) {
          sx = x;
          sy = y;
          fx = px;
          fy = py;
          return;
        }
      }
    }
  };

  // Emit the snake (x1, y1) → (x2, y2): a diagonal run, at most one edit step, another diagonal run.
  const emitSnake = (x1: number, y1: number, x2: number, y2: number) => {
    let x = x1;
    let y = y1;
    while (x < x2 && y < y2 && a[x] === b[y]) {
      x++;
      y++;
    }
    emitEqual(x1, x);
    if (x2 - x > y2 - y) {
      emitDelete(x, x + 1);
      x++;
    } else if (y2 - y > x2 - x) {
      emitInsert(y, y + 1);
    }
    emitEqual(x, x2);
  };

  // Recursion depth is O(log D): the middle snake splits the edit script roughly in half.
  const walk = (left: number, top: number, right: number, bottom: number) => {
    if (left === right) {
      emitInsert(top, bottom);
      return;
    }
    if (top === bottom) {
      emitDelete(left, right);
      return;
    }
    midpoint(left, top, right, bottom);
    const x1 = sx;
    const y1 = sy;
    const x2 = fx;
    const y2 = fy;
    walk(left, top, x1, y1);
    emitSnake(x1, y1, x2, y2);
    walk(x2, y2, right, bottom);
  };

  walk(0, 0, n, m);
  flushEqual();
  flushChange();
  return ops;
}

/** Map tokens to small integers so the inner loops compare numbers, not strings. */
function intern(tokens: string[], ids: Map<string, number>): Int32Array {
  const out = new Int32Array(tokens.length);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let id = ids.get(token);
    if (id === undefined) {
      id = ids.size;
      ids.set(token, id);
    }
    out[i] = id;
  }
  return out;
}
