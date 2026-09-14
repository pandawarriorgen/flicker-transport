// GF(256) 上的 Reed-Solomon 纠错码（本原多项式 0x11D，生成元 2）。
// 多项式一律采用「高次在前」表示，即 poly[0] 是最高次项系数。
// 无 DOM 依赖。

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}
function div(a, b) {
  if (b === 0) throw new Error('GF(256) 除零');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}
function inv(a) {
  return EXP[255 - LOG[a]];
}
function pow(a, n) {
  if (a === 0) return 0;
  let e = (LOG[a] * n) % 255;
  if (e < 0) e += 255;
  return EXP[e];
}

/* ---------------- 多项式运算 ---------------- */

function polyScale(p, s) {
  const out = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = mul(p[i], s);
  return out;
}

function polyAdd(p, q) {
  const out = new Uint8Array(Math.max(p.length, q.length));
  for (let i = 0; i < p.length; i++) out[i + out.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) out[i + out.length - q.length] ^= q[i];
  return out;
}

function polyMul(p, q) {
  const out = new Uint8Array(p.length + q.length - 1);
  for (let j = 0; j < q.length; j++) {
    const qj = q[j];
    if (qj === 0) continue;
    for (let i = 0; i < p.length; i++) out[i + j] ^= mul(p[i], qj);
  }
  return out;
}

function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

/** 合成除法，返回 [商, 余数]。 */
function polyDiv(dividend, divisor) {
  const out = Uint8Array.from(dividend);
  const dLen = divisor.length - 1;
  for (let i = 0; i < dividend.length - dLen; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < divisor.length; j++) {
      if (divisor[j] !== 0) out[i + j] ^= mul(divisor[j], coef);
    }
  }
  const sep = out.length - dLen;
  return [out.slice(0, sep), out.slice(sep)];
}

/* ---------------- 编码 ---------------- */

const genCache = new Map();

function generatorPoly(nsym) {
  let g = genCache.get(nsym);
  if (g) return g;
  g = Uint8Array.of(1);
  for (let i = 0; i < nsym; i++) g = polyMul(g, Uint8Array.of(1, pow(2, i)));
  genCache.set(nsym, g);
  return g;
}

/** 系统码编码：返回 [数据 || nsym 个校验字节]。 */
export function rsEncode(msg, nsym) {
  if (nsym === 0) return Uint8Array.from(msg);
  if (msg.length + nsym > 255) throw new Error('RS 码字长度超过 255');
  const gen = generatorPoly(nsym);
  const out = new Uint8Array(msg.length + nsym);
  out.set(msg, 0);
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  out.set(msg, 0);
  return out;
}

/* ---------------- 解码 ---------------- */

function calcSyndromes(msg, nsym) {
  const synd = new Uint8Array(nsym + 1); // synd[0] 恒为 0，方便后续下标对齐
  for (let i = 0; i < nsym; i++) synd[i + 1] = polyEval(msg, pow(2, i));
  return synd;
}

/** Berlekamp-Massey：由伴随式求错误位置多项式 Λ(x)。 */
function findErrorLocator(synd, nsym) {
  let errLoc = Uint8Array.of(1);
  let oldLoc = Uint8Array.of(1);
  for (let i = 0; i < nsym; i++) {
    const K = i + 1;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }
    const grown = new Uint8Array(oldLoc.length + 1);
    grown.set(oldLoc, 0);
    oldLoc = grown;
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  let s = 0;
  while (s < errLoc.length - 1 && errLoc[s] === 0) s++;
  return errLoc.slice(s);
}

/**
 * Chien 搜索：在整个 GF(256) 里找 Λ(x) 的根。
 * 根 x 的倒数才是错误位置值 X = α^coefPos，coefPos 再换算成码字下标。
 */
function findErrors(errLoc, nmess) {
  const errs = errLoc.length - 1;
  const pos = [];
  for (let i = 0; i < 255 && pos.length < errs; i++) {
    if (polyEval(errLoc, EXP[i]) !== 0) continue;
    const coefPos = (255 - i) % 255; // X = α^coefPos = (α^i)^-1
    const p = nmess - 1 - coefPos;
    if (p < 0 || p >= nmess) return null; // 根落在码字之外，说明这次纠错不可信
    pos.push(p);
  }
  return pos.length === errs ? pos : null;
}

function findErrataLocator(coefPos) {
  let eLoc = Uint8Array.of(1);
  for (const p of coefPos) eLoc = polyMul(eLoc, Uint8Array.of(pow(2, p), 1));
  return eLoc;
}

function findErrorEvaluator(syndRev, errLoc, nsym) {
  const divisor = new Uint8Array(nsym + 2);
  divisor[0] = 1;
  return polyDiv(polyMul(syndRev, errLoc), divisor)[1];
}

/** Forney 算法：算出每个错误位置上的错误值并修正。 */
function correctErrata(msg, synd, errPos) {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  const errLoc = findErrataLocator(coefPos);
  const syndRev = Uint8Array.from(synd).reverse();
  const errEval = findErrorEvaluator(syndRev, errLoc, errLoc.length - 1);

  const X = coefPos.map((p) => pow(2, p - 255));

  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = inv(Xi);
    let denom = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) denom = mul(denom, 1 ^ mul(XiInv, X[j]));
    }
    if (denom === 0) return null;
    let y = polyEval(errEval, XiInv);
    y = mul(Xi, y);
    msg[errPos[i]] ^= div(y, denom);
  }
  return msg;
}

// 内部函数，仅供测试与调试使用
export const _internals = {
  mul, div, inv, pow, polyAdd, polyMul, polyScale, polyEval, polyDiv,
  calcSyndromes, findErrorLocator, findErrors, findErrataLocator, findErrorEvaluator,
};

/**
 * 解码一个 RS 码字。
 * @returns {{ok: boolean, data: Uint8Array|null, errors: number}}
 */
export function rsDecode(codeword, nsym) {
  const msg = Uint8Array.from(codeword);
  if (nsym === 0) return { ok: true, data: msg, errors: 0 };

  const synd = calcSyndromes(msg, nsym);
  let clean = true;
  for (let i = 1; i < synd.length; i++) {
    if (synd[i] !== 0) {
      clean = false;
      break;
    }
  }
  if (clean) return { ok: true, data: msg.slice(0, msg.length - nsym), errors: 0 };

  const errLoc = findErrorLocator(synd, nsym);
  if (errLoc.length - 1 > (nsym >> 1)) return { ok: false, data: null, errors: -1 };

  const errPos = findErrors(errLoc, msg.length);
  if (!errPos || errPos.length === 0) return { ok: false, data: null, errors: -1 };

  if (!correctErrata(msg, synd, errPos)) return { ok: false, data: null, errors: -1 };

  // 修正后重新验证：Berlekamp-Massey 有可能误纠，这一步能挡掉大部分误纠。
  const check = calcSyndromes(msg, nsym);
  for (let i = 1; i < check.length; i++) {
    if (check[i] !== 0) return { ok: false, data: null, errors: -1 };
  }
  return { ok: true, data: msg.slice(0, msg.length - nsym), errors: errPos.length };
}

/* ---------------- 分块 + 交织 ----------------
 * 单个 RS 码字最长 255 字节，所以长载荷要切成多块。
 * 编码后再按「每块取一字节」的顺序交织输出，
 * 这样画面上一小片污损造成的连续错误会被摊到所有块上，而不是打爆某一块。 */

/** 给定载荷长度和每块校验字节数，算出分块方案。 */
export function planChunks(payloadLen, nsym) {
  const k = 255 - nsym;
  const nChunks = Math.max(1, Math.ceil(payloadLen / k));
  const base = Math.floor(payloadLen / nChunks);
  const extra = payloadLen % nChunks;
  const sizes = [];
  for (let i = 0; i < nChunks; i++) sizes.push(base + (i < extra ? 1 : 0));
  const encodedLen = payloadLen + nChunks * nsym;
  return { nChunks, sizes, encodedLen, nsym };
}

/** 已知总容量 capacity，求能塞下的最大载荷长度。 */
export function maxPayloadFor(capacity, nsym) {
  const k = 255 - nsym;
  let lo = 0;
  let hi = capacity;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (planChunks(mid, nsym).encodedLen <= capacity) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function rsEncodeInterleaved(payload, nsym) {
  const plan = planChunks(payload.length, nsym);
  const chunks = [];
  let off = 0;
  let maxLen = 0;
  for (const size of plan.sizes) {
    const c = rsEncode(payload.subarray(off, off + size), nsym);
    off += size;
    chunks.push(c);
    if (c.length > maxLen) maxLen = c.length;
  }
  const out = new Uint8Array(plan.encodedLen);
  let w = 0;
  for (let i = 0; i < maxLen; i++) {
    for (const c of chunks) if (i < c.length) out[w++] = c[i];
  }
  return out;
}

/** @returns {{ok: boolean, data: Uint8Array|null, errors: number}} */
export function rsDecodeInterleaved(encoded, payloadLen, nsym) {
  const plan = planChunks(payloadLen, nsym);
  if (plan.encodedLen > encoded.length) return { ok: false, data: null, errors: -1 };

  const chunks = plan.sizes.map((size) => new Uint8Array(size + nsym));
  const lens = plan.sizes.map((size) => size + nsym);
  const maxLen = Math.max(...lens);
  let r = 0;
  for (let i = 0; i < maxLen; i++) {
    for (let c = 0; c < chunks.length; c++) if (i < lens[c]) chunks[c][i] = encoded[r++];
  }

  const out = new Uint8Array(payloadLen);
  let off = 0;
  let errors = 0;
  for (let c = 0; c < chunks.length; c++) {
    const res = rsDecode(chunks[c], nsym);
    if (!res.ok) return { ok: false, data: null, errors: -1 };
    errors += res.errors;
    out.set(res.data, off);
    off += res.data.length;
  }
  return { ok: true, data: out, errors };
}
