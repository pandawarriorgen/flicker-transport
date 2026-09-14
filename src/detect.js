// 从摄像头画面里把一帧闪烁码读出来。无 DOM 依赖（输入是裸 RGBA 数组）。
//
// 流水线：
//   灰度 → 自适应二值化 → 找四角定位图案 → 挑出最合适的四边形
//   → 单应变换（平面在针孔相机下的映射是精确的射影变换，所以一个单应就够）
//   → 猜版面尺寸 n（用功能格对比度打分，试 n、n±2、n±4）
//   → 按格采样 RGB → 判断旋转了几个 90° → 转正
//   → 分块归一化（消除光照不均和镜头暗角）
//   → 读帧头（恒为黑白）→ 读校准带得到本次拍摄下各颜色的真实值 → 分类数据格

import {
  HEADER_NSYM,
  MAX_GRID,
  MIN_GRID,
  PALETTE_BY_ID,
  buildLayout,
  dataIndicesToBytes,
  headerBitsToBytes,
  paletteByName,
} from './format.js';
import { rsDecode } from './rs.js';
import { unpackHeader } from './protocol.js';

/* ================= 灰度与二值化 ================= */

export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    g[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return g;
}

/**
 * Bradley-Roth 自适应阈值：用积分图求局部均值，像素低于均值的 88% 判黑。
 * 相对阈值让它对整体明暗、暗角都免疫，且平坦区域不会放大噪声。
 */
export function binarize(gray, w, h) {
  const iw = w + 1;
  const integral = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const src = y * w;
    const cur = (y + 1) * iw;
    const prev = y * iw;
    for (let x = 0; x < w; x++) {
      rowSum += gray[src + x];
      integral[cur + x + 1] = integral[prev + x + 1] + rowSum;
    }
  }

  const rad = Math.max(4, Math.round(Math.min(w, h) / 24));
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad);
    const y1 = Math.min(h - 1, y + rad);
    const rowA = y0 * iw;
    const rowB = (y1 + 1) * iw;
    const src = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad);
      const x1 = Math.min(w - 1, x + rad);
      const count = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[rowB + x1 + 1] - integral[rowA + x1 + 1] - integral[rowB + x0] + integral[rowA + x0];
      if (gray[src + x] * count * 100 < sum * 88) bin[src + x] = 1;
    }
  }
  return bin;
}

/* ================= 定位图案检测（QR 式 1:1:3:1:1） ================= */

function foundPatternCross(st) {
  let total = 0;
  for (let i = 0; i < 5; i++) {
    if (st[i] === 0) return false;
    total += st[i];
  }
  if (total < 7) return false;
  const m = total / 7;
  const maxVar = m / 2;
  return (
    Math.abs(m - st[0]) < maxVar &&
    Math.abs(m - st[1]) < maxVar &&
    Math.abs(3 * m - st[2]) < 3 * maxVar &&
    Math.abs(m - st[3]) < maxVar &&
    Math.abs(m - st[4]) < maxVar
  );
}

function centerFromEnd(st, end) {
  return end - st[4] - st[3] - st[2] / 2;
}

function crossCheckVertical(bin, w, h, startY, centerX, maxCount, originalTotal) {
  const st = [0, 0, 0, 0, 0];
  let y = startY;
  while (y >= 0 && bin[y * w + centerX]) {
    st[2]++;
    y--;
  }
  if (y < 0) return NaN;
  while (y >= 0 && !bin[y * w + centerX] && st[1] <= maxCount) {
    st[1]++;
    y--;
  }
  if (y < 0 || st[1] > maxCount) return NaN;
  while (y >= 0 && bin[y * w + centerX] && st[0] <= maxCount) {
    st[0]++;
    y--;
  }
  if (st[0] > maxCount) return NaN;

  y = startY + 1;
  while (y < h && bin[y * w + centerX]) {
    st[2]++;
    y++;
  }
  if (y === h) return NaN;
  while (y < h && !bin[y * w + centerX] && st[3] < maxCount) {
    st[3]++;
    y++;
  }
  if (y === h || st[3] >= maxCount) return NaN;
  while (y < h && bin[y * w + centerX] && st[4] < maxCount) {
    st[4]++;
    y++;
  }
  if (st[4] >= maxCount) return NaN;

  const total = st[0] + st[1] + st[2] + st[3] + st[4];
  if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
  return foundPatternCross(st) ? centerFromEnd(st, y) : NaN;
}

function crossCheckHorizontal(bin, w, h, startX, centerY, maxCount, originalTotal) {
  const st = [0, 0, 0, 0, 0];
  const row = centerY * w;
  let x = startX;
  while (x >= 0 && bin[row + x]) {
    st[2]++;
    x--;
  }
  if (x < 0) return NaN;
  while (x >= 0 && !bin[row + x] && st[1] <= maxCount) {
    st[1]++;
    x--;
  }
  if (x < 0 || st[1] > maxCount) return NaN;
  while (x >= 0 && bin[row + x] && st[0] <= maxCount) {
    st[0]++;
    x--;
  }
  if (st[0] > maxCount) return NaN;

  x = startX + 1;
  while (x < w && bin[row + x]) {
    st[2]++;
    x++;
  }
  if (x === w) return NaN;
  while (x < w && !bin[row + x] && st[3] < maxCount) {
    st[3]++;
    x++;
  }
  if (x === w || st[3] >= maxCount) return NaN;
  while (x < w && bin[row + x] && st[4] < maxCount) {
    st[4]++;
    x++;
  }
  if (st[4] >= maxCount) return NaN;

  const total = st[0] + st[1] + st[2] + st[3] + st[4];
  if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
  return foundPatternCross(st) ? centerFromEnd(st, x) : NaN;
}

export function findFinderPatterns(bin, w, h) {
  const candidates = [];
  const st = new Int32Array(5);
  const iSkip = Math.max(2, Math.floor(h / 300));

  const consider = (y, x) => {
    const total = st[0] + st[1] + st[2] + st[3] + st[4];
    let cx = centerFromEnd(st, x);
    const cy = crossCheckVertical(bin, w, h, y, Math.round(cx), st[2], total);
    if (Number.isNaN(cy)) return;
    cx = crossCheckHorizontal(bin, w, h, Math.round(cx), Math.round(cy), st[2], total);
    if (Number.isNaN(cx)) return;

    const size = total / 7;
    for (const c of candidates) {
      if (Math.abs(c.x - cx) <= c.size && Math.abs(c.y - cy) <= c.size) {
        const k = c.count;
        c.x = (c.x * k + cx) / (k + 1);
        c.y = (c.y * k + cy) / (k + 1);
        c.size = (c.size * k + size) / (k + 1);
        c.count = k + 1;
        return;
      }
    }
    candidates.push({ x: cx, y: cy, size, count: 1 });
  };

  for (let y = iSkip - 1; y < h; y += iSkip) {
    st.fill(0);
    let state = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (bin[row + x]) {
        if ((state & 1) === 1) state++;
        st[state]++;
      } else if ((state & 1) === 0) {
        if (state === 4) {
          if (foundPatternCross(st)) consider(y, x);
          st[0] = st[2];
          st[1] = st[3];
          st[2] = st[4];
          st[3] = 1;
          st[4] = 0;
          state = 3;
        } else {
          st[++state]++;
        }
      } else {
        st[state]++;
      }
    }
    if (state === 4 && foundPatternCross(st)) consider(y, w);
  }
  return candidates;
}

/* ================= 从候选点里挑出一个四边形 ================= */

function orderQuad(pts) {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  const sorted = pts
    .map((p) => ({ ...p, ang: Math.atan2(p.y - cy, p.x - cx) }))
    .sort((a, b) => a.ang - b.ang);
  // 归一到「y 轴向下时的顺时针」，与格坐标 TL→TR→BR→BL 同向
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = sorted[i];
    const b = sorted[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) sorted.reverse();
  return sorted;
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i];
    const n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

export function selectQuad(candidates) {
  let list = candidates.filter((c) => c.count >= 2);
  if (list.length < 4) list = candidates.slice();
  if (list.length < 4) return null;
  list.sort((a, b) => b.count - a.count || b.size - a.size);
  list = list.slice(0, 12);

  let best = null;
  let bestArea = 0;
  const N = list.length;
  for (let i = 0; i < N - 3; i++) {
    for (let j = i + 1; j < N - 2; j++) {
      for (let k = j + 1; k < N - 1; k++) {
        for (let l = k + 1; l < N; l++) {
          const combo = [list[i], list[j], list[k], list[l]];
          let sMin = Infinity;
          let sMax = 0;
          for (const c of combo) {
            if (c.size < sMin) sMin = c.size;
            if (c.size > sMax) sMax = c.size;
          }
          if (sMax / sMin > 1.7) continue; // 四个定位图案的模块尺寸应当接近

          const q = orderQuad(combo);
          if (!isConvex(q)) continue;

          let eMin = Infinity;
          let eMax = 0;
          for (let e = 0; e < 4; e++) {
            const a = q[e];
            const b = q[(e + 1) % 4];
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (d < eMin) eMin = d;
            if (d > eMax) eMax = d;
          }
          if (eMax / eMin > 3) continue; // 正方形再怎么斜也不至于差三倍
          if (eMin < sMin * 8) continue; // 太小，多半是噪点凑出来的

          const area = quadArea(q);
          if (area > bestArea) {
            bestArea = area;
            best = q;
          }
        }
      }
    }
  }
  return best;
}

/* ================= 单应变换（Heckbert 单位正方形 → 四边形） ================= */

export function squareToQuad(q) {
  const [p0, p1, p2, p3] = q; // (0,0) (1,0) (1,1) (0,1)
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let a, b, c, d, e, f, g, hh;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = p1.x - p0.x;
    b = p2.x - p1.x;
    c = p0.x;
    d = p1.y - p0.y;
    e = p2.y - p1.y;
    f = p0.y;
    g = 0;
    hh = 0;
  } else {
    const det = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(det) < 1e-9) return null;
    g = (dx3 * dy2 - dy3 * dx2) / det;
    hh = (dx1 * dy3 - dy1 * dx3) / det;
    a = p1.x - p0.x + g * p1.x;
    b = p3.x - p0.x + hh * p3.x;
    c = p0.x;
    d = p1.y - p0.y + g * p1.y;
    e = p3.y - p0.y + hh * p3.y;
    f = p0.y;
  }
  return (u, v, out) => {
    const den = g * u + hh * v + 1;
    out[0] = (a * u + b * v + c) / den;
    out[1] = (d * u + e * v + f) / den;
    return out;
  };
}

/* ================= 按格采样 ================= */

/** 双线性插值取一个亚像素点。格子只有四五个像素宽时，整像素取样误差太大。 */
function bilinear(rgba, w, h, x, y, out) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return false;
  const x0 = x | 0;
  const y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0;
  const fy = y - y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const o00 = (y0 * w + x0) * 4;
  const o10 = (y0 * w + x1) * 4;
  const o01 = (y1 * w + x0) * 4;
  const o11 = (y1 * w + x1) * 4;
  out[0] = rgba[o00] * w00 + rgba[o10] * w10 + rgba[o01] * w01 + rgba[o11] * w11;
  out[1] = rgba[o00 + 1] * w00 + rgba[o10 + 1] * w10 + rgba[o01 + 1] * w01 + rgba[o11 + 1] * w11;
  out[2] = rgba[o00 + 2] * w00 + rgba[o10 + 2] * w10 + rgba[o01 + 2] * w01 + rgba[o11 + 2] * w11;
  return true;
}

/** 格坐标（0..n）→ 单应变换的 uv（以四个定位图案中心为单位正方形）。 */
function gridToUnit(g, n) {
  return (g - 3.5) / (n - 7);
}

// 每格取 3×3 共 9 个亚像素点：既能压噪声，偏移量又小到不会吃进邻格
const SUB_OFFSETS = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
];

/** 采一个格子的平均 RGB。spread 是偏移量（单位正方形坐标）。 */
function sampleCell(rgba, w, h, H, u, v, spread, px, tmp, out) {
  let r = 0;
  let g = 0;
  let b = 0;
  let cnt = 0;
  for (let i = 0; i < SUB_OFFSETS.length; i++) {
    H(u + SUB_OFFSETS[i][0] * spread, v + SUB_OFFSETS[i][1] * spread, px);
    if (!bilinear(rgba, w, h, px[0], px[1], tmp)) continue;
    r += tmp[0];
    g += tmp[1];
    b += tmp[2];
    cnt++;
  }
  if (cnt === 0) return false;
  out[0] = r / cnt;
  out[1] = g / cnt;
  out[2] = b / cnt;
  return true;
}

// 亚采样点偏移 0.25 格：再大就会吃到相邻格，再小则抗噪不足
const SUB_SPREAD_CELLS = 0.25;
const spreadFor = (n) => SUB_SPREAD_CELLS / (n - 7);

function sampleSubsetLum(rgba, w, h, n, H, cells) {
  const spread = spreadFor(n);
  const px = [0, 0];
  const tmp = [0, 0, 0];
  const rgb = [0, 0, 0];
  const out = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const idx = cells[i];
    const cy = (idx / n) | 0;
    const cx = idx - cy * n;
    const u = gridToUnit(cx + 0.5, n);
    const v = gridToUnit(cy + 0.5, n);
    out[i] = sampleCell(rgba, w, h, H, u, v, spread, px, tmp, rgb)
      ? (rgb[0] * 77 + rgb[1] * 150 + rgb[2] * 29) / 256
      : -1;
  }
  return out;
}

function sampleAllCells(rgba, w, h, n, H) {
  const spread = spreadFor(n);
  const out = new Float32Array(n * n * 3);
  const px = [0, 0];
  const tmp = [0, 0, 0];
  const rgb = [0, 0, 0];
  let missing = 0;
  for (let cy = 0; cy < n; cy++) {
    const v = gridToUnit(cy + 0.5, n);
    for (let cx = 0; cx < n; cx++) {
      const u = gridToUnit(cx + 0.5, n);
      const o = (cy * n + cx) * 3;
      if (sampleCell(rgba, w, h, H, u, v, spread, px, tmp, rgb)) {
        out[o] = rgb[0];
        out[o + 1] = rgb[1];
        out[o + 2] = rgb[2];
      } else {
        missing++;
      }
    }
  }
  return { cells: out, missing };
}

/** 用「该黑的格子有多暗、该白的格子有多亮」给一个候选版面尺寸打分。 */
function scoreGrid(rgba, w, h, n, H) {
  const layout = buildLayout(n);
  const lum = sampleSubsetLum(rgba, w, h, n, H, layout.checkCells);
  let sumB = 0;
  let cntB = 0;
  let sumW = 0;
  let cntW = 0;
  for (let i = 0; i < lum.length; i++) {
    if (lum[i] < 0) continue;
    if (layout.checkColor[i]) {
      sumB += lum[i];
      cntB++;
    } else {
      sumW += lum[i];
      cntW++;
    }
  }
  if (cntB < 8 || cntW < 8) return -1;
  return (sumW / cntW - sumB / cntB) / 255;
}

/* ================= 旋转 ================= */

function rotateRGBCW(src, n, times) {
  let cur = src;
  for (let t = 0; t < ((times % 4) + 4) % 4; t++) {
    const out = new Float32Array(n * n * 3);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const s = (y * n + x) * 3;
        const d = (x * n + (n - 1 - y)) * 3;
        out[d] = cur[s];
        out[d + 1] = cur[s + 1];
        out[d + 2] = cur[s + 2];
      }
    }
    cur = out;
  }
  return cur;
}

/** 四个方向块里最暗的那个就是真正的左上角。 */
function detectRotation(cells, n, layout) {
  let darkest = 0;
  let darkestVal = Infinity;
  for (let c = 0; c < 4; c++) {
    const blk = layout.orientationBlocks[c];
    let sum = 0;
    for (let i = 0; i < blk.length; i++) {
      const o = blk[i] * 3;
      sum += cells[o] * 0.3 + cells[o + 1] * 0.59 + cells[o + 2] * 0.11;
    }
    const mean = sum / blk.length;
    if (mean < darkestVal) {
      darkestVal = mean;
      darkest = c;
    }
  }
  // 当前矩阵 = 正位顺时针转 darkest 步，再补 (4-darkest) 步即可转正
  return (4 - darkest) % 4;
}

/* ================= 分块归一化 ================= */

/**
 * 按 8×8 格分块求每个通道的局部黑/白电平，再把每格线性拉伸到 0~255。
 * 这样镜头暗角、屏幕亮度不均、局部反光都会被抵消掉。
 */
function normalizeCells(cells, n, block = 8) {
  const nb = Math.ceil(n / block);
  const mins = new Float32Array(nb * nb * 3).fill(255);
  const maxs = new Float32Array(nb * nb * 3);

  for (let y = 0; y < n; y++) {
    const by = (y / block) | 0;
    for (let x = 0; x < n; x++) {
      const bo = (by * nb + ((x / block) | 0)) * 3;
      const o = (y * n + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const v = cells[o + ch];
        if (v < mins[bo + ch]) mins[bo + ch] = v;
        if (v > maxs[bo + ch]) maxs[bo + ch] = v;
      }
    }
  }

  // 3×3 块平滑，避免块与块之间出现硬边
  const sMin = new Float32Array(nb * nb * 3);
  const sMax = new Float32Array(nb * nb * 3);
  for (let by = 0; by < nb; by++) {
    for (let bx = 0; bx < nb; bx++) {
      for (let ch = 0; ch < 3; ch++) {
        let a = 0;
        let b = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = by + dy;
          if (yy < 0 || yy >= nb) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = bx + dx;
            if (xx < 0 || xx >= nb) continue;
            const bo = (yy * nb + xx) * 3 + ch;
            a += mins[bo];
            b += maxs[bo];
            cnt++;
          }
        }
        const bo = (by * nb + bx) * 3 + ch;
        sMin[bo] = a / cnt;
        sMax[bo] = b / cnt;
      }
    }
  }

  const out = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    const by = (y / block) | 0;
    for (let x = 0; x < n; x++) {
      const bo = (by * nb + ((x / block) | 0)) * 3;
      const o = (y * n + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const lo = sMin[bo + ch];
        const span = sMax[bo + ch] - lo;
        if (span < 10) {
          out[o + ch] = 128;
        } else {
          const v = (255 * (cells[o + ch] - lo)) / span;
          out[o + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
  }
  return out;
}

/* ================= 用某个候选版面尺寸完整解一遍 ================= */

/**
 * 采样 → 转正 → 归一化 → 读帧头 → 读校准带 → 分类数据格。
 * 帧头带 RS(32,16) + CRC16，通过了基本可以断定版面尺寸猜对了。
 */
function attemptGrid(rgba, w, h, n, H) {
  const layout = buildLayout(n);
  const sampled = sampleAllCells(rgba, w, h, n, H);
  if (sampled.missing > n * n * 0.02) return { ok: false, reason: 'out-of-frame' };

  const rot = detectRotation(sampled.cells, n, layout);
  const norm = normalizeCells(rotateRGBCW(sampled.cells, n, rot), n);

  // 帧头恒为黑白，先读它才知道后面用哪套调色板
  const hBits = new Uint8Array(layout.headerCells.length);
  for (let i = 0; i < layout.headerCells.length; i++) {
    const p = layout.headerCells[i] * 3;
    const lum = norm[p] * 0.3 + norm[p + 1] * 0.59 + norm[p + 2] * 0.11;
    hBits[i] = lum < 128 ? 1 : 0;
  }
  const headerCw = headerBitsToBytes(hBits);
  const hr = rsDecode(headerCw, HEADER_NSYM);
  if (!hr.ok) return { ok: false, reason: 'header-rs', rotation: rot, headerCw };
  const header = unpackHeader(hr.data);
  if (!header) return { ok: false, reason: 'header-crc', rotation: rot, headerCw };

  // 校准带：这次拍摄下「红」到底拍成了什么值，问画面本身要答案。
  // 对每个通道用全部校准格最小二乘拟合 观测 ≈ gain·理想 + bias，
  // 比直接对每种颜色取均值更稳——模糊会让相邻格互相串色，逐色求均值容易被带偏。
  const pal = paletteByName(PALETTE_BY_ID[header.paletteId].name);
  const P = pal.colors.length;
  const centroids = new Float32Array(P * 3);
  const N = layout.calibCells.length;
  for (let ch = 0; ch < 3; ch++) {
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < N; i++) {
      const x = pal.colors[layout.calibOrdinal[i] % P][ch];
      const y = norm[layout.calibCells[i] * 3 + ch];
      sx += x;
      sy += y;
      sxy += x * y;
      sxx += x * x;
    }
    const den = N * sxx - sx * sx;
    let gain = 1;
    let bias = 0;
    if (N >= 8 && Math.abs(den) > 1e-6) {
      gain = (N * sxy - sx * sy) / den;
      bias = (sy - gain * sx) / N;
      if (!(gain > 0.2) || gain > 3) {
        gain = 1;
        bias = 0;
      }
    }
    for (let s = 0; s < P; s++) centroids[s * 3 + ch] = gain * pal.colors[s][ch] + bias;
  }

  // 数据格：找最近的颜色中心
  const indices = new Uint8Array(layout.dataCells.length);
  for (let i = 0; i < layout.dataCells.length; i++) {
    const p = layout.dataCells[i] * 3;
    const r = norm[p];
    const g = norm[p + 1];
    const b = norm[p + 2];
    let best = 0;
    let bestD = Infinity;
    for (let s = 0; s < P; s++) {
      const dr = r - centroids[s * 3];
      const dg = g - centroids[s * 3 + 1];
      const db = b - centroids[s * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    indices[i] = best;
  }

  return { ok: true, rotation: rot, header, payload: dataIndicesToBytes(indices, pal.bits) };
}

/* ================= 主入口 ================= */

const DEFAULT_OPTS = { gridHint: 0, minScore: 0.3, maxAttempts: 4 };

/**
 * 从一帧 RGBA 图像里读出闪烁码。
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} w
 * @param {number} h
 * @param {{gridHint?:number, minScore?:number}} [opts]
 * @returns {{ok:boolean, reason?:string, quad?:Array, gridSize?:number,
 *            header?:object, payload?:Uint8Array, score?:number}}
 */
export function readCode(rgba, w, h, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts };
  const gray = toGray(rgba, w, h);
  const bin = binarize(gray, w, h);
  const candidates = findFinderPatterns(bin, w, h);
  if (candidates.length < 4) return { ok: false, reason: 'no-finder', candidates };

  const quad = selectQuad(candidates);
  if (!quad) return { ok: false, reason: 'no-quad', candidates };

  const H = squareToQuad(quad);
  if (!H) return { ok: false, reason: 'degenerate', quad };

  // 由「边长 / 模块尺寸」估计版面尺寸，再在附近搜一搜
  let edgeSum = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    edgeSum += Math.hypot(a.x - b.x, a.y - b.y);
  }
  const edge = edgeSum / 4;
  const moduleSize = (quad[0].size + quad[1].size + quad[2].size + quad[3].size) / 4;

  let nEst = Math.round(edge / moduleSize) + 7;
  if (nEst % 2 === 0) nEst++;

  // 模糊会让游程测出来的模块尺寸偏小，nEst 常常差个 2~6，
  // 所以先用功能格对比度粗排，再拿帧头的 RS+CRC 做最终裁决。
  const tried = new Set();
  const scored = [];
  for (const d of [0, -2, 2, -4, 4, -6, 6, -8, 8]) {
    const cand = nEst + d;
    if (cand % 2 === 0 || cand < MIN_GRID || cand > MAX_GRID || tried.has(cand)) continue;
    tried.add(cand);
    const score = scoreGrid(rgba, w, h, cand, H);
    if (score >= o.minScore) scored.push({ n: cand, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // 上一帧成功用的尺寸最可能还对，插到最前面先试
  if (o.gridHint && o.gridHint % 2 === 1 && o.gridHint >= MIN_GRID && o.gridHint <= MAX_GRID) {
    const i = scored.findIndex((s) => s.n === o.gridHint);
    if (i > 0) scored.unshift(scored.splice(i, 1)[0]);
    else if (i < 0) {
      const score = scoreGrid(rgba, w, h, o.gridHint, H);
      if (score >= o.minScore) scored.unshift({ n: o.gridHint, score });
    }
  }
  if (scored.length === 0) return { ok: false, reason: 'grid-mismatch', quad };

  let lastFail = null;
  for (const cand of scored.slice(0, o.maxAttempts)) {
    const r = attemptGrid(rgba, w, h, cand.n, H);
    if (r.ok) return { ...r, quad, gridSize: cand.n, score: cand.score };
    if (!lastFail) lastFail = { ...r, quad, gridSize: cand.n, score: cand.score };
  }
  return { ok: false, ...lastFail };
}
