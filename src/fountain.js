// LT 喷泉码（Luby Transform）。
//
// 为什么需要它：屏幕→摄像头是一条纯单向、会随机丢帧的信道。
// 如果按 1..N 顺序播放，接收端漏掉第 37 帧就必须等下一整轮；
// 喷泉码则是「无速率」的——发送端可以无限生成随机组合帧，
// 接收端攒够任意约 1.05K 个不同帧就能解出全部 K 个原始块。
//
// 发送端与接收端靠同一个 seed 复现出完全相同的块组合，所以帧头只需带 4 字节 seed。
// 无 DOM 依赖。

import { mulberry32 } from './util.js';

/* ---------------- 度分布 ---------------- */

const cdfCache = new Map();

/**
 * 鲁棒孤子分布的两个调节参数。数值由 test/_lt.mjs 的参数扫描定出：
 * 在 K = 10 ~ 3000、丢帧 40% 的条件下平均开销最低。
 * 改动后必须调用 resetLtTuning() 清掉分布缓存。
 */
// delta 名义上是「允许的解码失败概率」，取这么大看着反直觉，
// 但我们是无限循环发送的——所谓「失败」只意味着要多收几帧，不是真的失败，
// 所以按平均开销最优来选就对了。
export const LT_TUNING = { c: 0.12, delta: 0.9 };

export function resetLtTuning() {
  cdfCache.clear();
}

/**
 * 鲁棒孤子分布（Robust Soliton）的累积分布表。
 * c 越小 / delta 越小，尖峰越靠后：解码失败概率更低，但平均要多收一些帧。
 */
function robustSolitonCdf(K) {
  const { c, delta } = LT_TUNING;
  const key = K;
  const cached = cdfCache.get(key);
  if (cached) return cached;

  const rho = new Float64Array(K + 1);
  rho[1] = 1 / K;
  for (let d = 2; d <= K; d++) rho[d] = 1 / (d * (d - 1));

  const tau = new Float64Array(K + 1);
  const R = c * Math.log(K / delta) * Math.sqrt(K);
  const pivot = Math.max(1, Math.floor(K / R));
  for (let d = 1; d < pivot; d++) tau[d] = R / (d * K);
  if (pivot <= K) tau[pivot] = (R * Math.log(R / delta)) / K;

  let Z = 0;
  for (let d = 1; d <= K; d++) Z += rho[d] + tau[d];

  const cdf = new Float64Array(K + 1);
  let acc = 0;
  for (let d = 1; d <= K; d++) {
    acc += (rho[d] + tau[d]) / Z;
    cdf[d] = acc;
  }
  cdf[K] = 1;
  cdfCache.set(key, cdf);
  return cdf;
}

function sampleDegree(rand, K) {
  if (K <= 2) return 1 + Math.floor(rand() * K);
  const cdf = robustSolitonCdf(K);
  const u = rand();
  // 度数普遍很小，线性扫描比二分更快
  for (let d = 1; d <= K; d++) if (u <= cdf[d]) return d;
  return K;
}

/**
 * 由 seed 复现出这一帧参与异或的源块下标。
 * 约定：seed < K 时退化为「系统码」，直接就是第 seed 个源块。
 * 这样理想情况下前 K 帧就能收完，不必付喷泉码的开销。
 */
export function pickBlocks(seed, K) {
  if (seed < K) return [seed];
  const rand = mulberry32((seed * 2654435761) >>> 0);
  const d = sampleDegree(rand, K);
  if (d >= K) {
    const all = new Array(K);
    for (let i = 0; i < K; i++) all[i] = i;
    return all;
  }
  // Floyd 算法：O(d) 无重复抽样
  const set = new Set();
  for (let j = K - d; j < K; j++) {
    const t = Math.floor(rand() * (j + 1));
    if (set.has(t)) set.add(j);
    else set.add(t);
  }
  return Array.from(set);
}

/* ---------------- 编码器 ---------------- */

export class LtEncoder {
  /** @param {Uint8Array} data 已按 blockSize 补齐到 K*blockSize 的数据 */
  constructor(data, blockSize) {
    this.blockSize = blockSize;
    this.K = Math.ceil(data.length / blockSize);
    this.data = new Uint8Array(this.K * blockSize);
    this.data.set(data, 0);
  }

  /** 生成第 seed 号编码块。 */
  make(seed) {
    const { blockSize, data } = this;
    const ids = pickBlocks(seed, this.K);
    const out = new Uint8Array(blockSize);
    out.set(data.subarray(ids[0] * blockSize, ids[0] * blockSize + blockSize));
    for (let i = 1; i < ids.length; i++) {
      const off = ids[i] * blockSize;
      for (let b = 0; b < blockSize; b++) out[b] ^= data[off + b];
    }
    return out;
  }
}

/* ---------------- 解码器（剥离法 / peeling） ---------------- */

export class LtDecoder {
  constructor(K, blockSize) {
    this.K = K;
    this.blockSize = blockSize;
    this.solved = new Array(K).fill(null);
    this.solvedCount = 0;
    /** @type {Array<{ids:Set<number>, data:Uint8Array}|null>} */
    this.symbols = [];
    /** @type {Map<number, Set<number>>} 源块下标 -> 仍包含它的符号编号 */
    this.byIndex = new Map();
    this.seenSeeds = new Set();
    this.acceptedCount = 0;
  }

  get done() {
    return this.solvedCount >= this.K;
  }
  get progress() {
    return this.solvedCount / this.K;
  }

  /**
   * 收下一个编码块。
   * @returns {'duplicate'|'redundant'|'accepted'}
   */
  add(seed, payload) {
    if (this.seenSeeds.has(seed)) return 'duplicate';
    this.seenSeeds.add(seed);
    if (this.done) return 'redundant';

    const ids = pickBlocks(seed, this.K);
    const data = Uint8Array.from(payload.subarray(0, this.blockSize));
    const remaining = new Set();
    for (const id of ids) {
      const s = this.solved[id];
      if (s) {
        for (let b = 0; b < this.blockSize; b++) data[b] ^= s[b];
      } else {
        remaining.add(id);
      }
    }
    if (remaining.size === 0) return 'redundant';

    this.acceptedCount++;
    const symIdx = this.symbols.length;
    this.symbols.push({ ids: remaining, data });
    for (const id of remaining) {
      let set = this.byIndex.get(id);
      if (!set) this.byIndex.set(id, (set = new Set()));
      set.add(symIdx);
    }
    if (remaining.size === 1) this._peel([symIdx]);
    return 'accepted';
  }

  _peel(queue) {
    while (queue.length) {
      const symIdx = queue.pop();
      const sym = this.symbols[symIdx];
      if (!sym || sym.ids.size !== 1) continue;
      const id = sym.ids.values().next().value;
      const value = sym.data;

      // 释放该符号
      this.symbols[symIdx] = null;
      const holders = this.byIndex.get(id);
      if (holders) holders.delete(symIdx);

      if (this.solved[id]) continue;
      this.solved[id] = value;
      this.solvedCount++;

      if (holders) {
        for (const other of holders) {
          const s = this.symbols[other];
          if (!s) continue;
          for (let b = 0; b < this.blockSize; b++) s.data[b] ^= value[b];
          s.ids.delete(id);
          if (s.ids.size === 1) queue.push(other);
          else if (s.ids.size === 0) this.symbols[other] = null;
        }
        this.byIndex.delete(id);
      }
      if (this.done) break;
    }
  }

  /** 拼出完整数据（长度 K*blockSize，尾部可能有填充）。 */
  assemble() {
    if (!this.done) return null;
    const out = new Uint8Array(this.K * this.blockSize);
    for (let i = 0; i < this.K; i++) out.set(this.solved[i], i * this.blockSize);
    return out;
  }
}
