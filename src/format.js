// 闪烁码的「版面」定义：一帧长什么样、哪个格子放什么。
// 发送端和接收端共用这一份定义。无 DOM 依赖。
//
// 版面（n×n 格）：
//   ┌──────┬──────────────────┬──────┐
//   │ 定位 │   校准带(上)     │ 定位 │   四角 7×7 定位图案（QR 式 1:1:3:1:1）
//   ├──────┘                  └──────┤   → 摄像头据此算出单应矩阵
//   │ 校  ▣ 方向块        数据    校 │
//   │ 准         ┌─────┐        准  │   四个 3×3 方向块，只有左上是黑的
//   │ 带         │对齐 │        带  │   → 用来判断画面转了几个 90°
//   │ (左)       └─────┘       (右) │
//   ├──────┐                  ┌──────┤   校准带：已知颜色的格子
//   │ 定位 │   校准带(下)     │ 定位 │   → 让接收端学会摄像头拍出来的真实色值
//   └──────┴──────────────────┴──────┘
//
// 数据区里还散布着 256 个「帧头格」，永远只用黑白 1bit 编码——
// 因为要先读出帧头才知道这一帧用的是哪套调色板，不能自己依赖自己。

import { BitReader, BitWriter } from './util.js';

/* ---------------- 调色板 ---------------- */

export const PALETTES = {
  // 黑白：最稳，任何摄像头任何光照都能读
  bw: {
    id: 0,
    bits: 1,
    colors: [
      [255, 255, 255],
      [0, 0, 0],
    ],
  },
  // 四灰阶：容量翻倍，不受摄像头色度二次采样影响
  gray4: {
    id: 1,
    bits: 2,
    colors: [
      [255, 255, 255],
      [174, 174, 174],
      [88, 88, 88],
      [0, 0, 0],
    ],
  },
  // RGB 立方体八顶点：容量最大，需要光线好、屏幕不反光
  rgb8: {
    id: 2,
    bits: 3,
    colors: [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [255, 255, 0],
      [0, 0, 255],
      [255, 0, 255],
      [0, 255, 255],
      [255, 255, 255],
    ],
  },
};

export const PALETTE_BY_ID = Object.fromEntries(
  Object.entries(PALETTES).map(([name, p]) => [p.id, { name, ...p }])
);

export function paletteByName(name) {
  const p = PALETTES[name];
  if (!p) throw new Error(`未知调色板: ${name}`);
  return { name, ...p };
}

/* ---------------- 常量 ---------------- */

export const FINDER_SIZE = 7; // 定位图案边长
export const RESERVE = 8; // 定位图案 + 分隔白边
export const ALIGN_SIZE = 5; // 中心对齐图案边长
export const ORIENT_SIZE = 3; // 方向块边长
export const ORIENT_OFF = 8; // 方向块距角落的格数
export const CALIB_OFF = 8; // 校准带所在的行/列
export const CALIB_START = 11; // 校准带起始位置（避开方向块）

export const HEADER_DATA_BYTES = 16;
export const HEADER_NSYM = 16; // 帧头的 RS 校验字节数，可纠 8 字节错
export const HEADER_CELLS = (HEADER_DATA_BYTES + HEADER_NSYM) * 8; // = 256

export const MIN_GRID = 33;
export const MAX_GRID = 129;

/* ---------------- 版面构建 ---------------- */

const layoutCache = new Map();

function drawFinder(fn, fc, n, ox, oy) {
  // 7×7 同心方块
  for (let dy = 0; dy < FINDER_SIZE; dy++) {
    for (let dx = 0; dx < FINDER_SIZE; dx++) {
      const black =
        dx === 0 ||
        dx === 6 ||
        dy === 0 ||
        dy === 6 ||
        (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      const idx = (oy + dy) * n + (ox + dx);
      fn[idx] = 1;
      fc[idx] = black ? 1 : 0;
    }
  }
}

function drawSeparator(fn, fc, n, x0, y0) {
  // 8×8 保留区里除去 7×7 的那一圈，全部涂白
  for (let dy = 0; dy < RESERVE; dy++) {
    for (let dx = 0; dx < RESERVE; dx++) {
      const idx = (y0 + dy) * n + (x0 + dx);
      if (fn[idx]) continue;
      fn[idx] = 1;
      fc[idx] = 0;
    }
  }
}

/**
 * 构建（并缓存）尺寸为 n 的版面。
 * @param {number} n 每边格数，奇数
 */
export function buildLayout(n) {
  const cached = layoutCache.get(n);
  if (cached) return cached;
  if (n < MIN_GRID || n > MAX_GRID || n % 2 === 0) {
    throw new Error(`版面尺寸非法: ${n}（需为 ${MIN_GRID}~${MAX_GRID} 之间的奇数）`);
  }

  const total = n * n;
  const isFunction = new Uint8Array(total);
  const funcColor = new Uint8Array(total); // 1=黑 0=白

  // 1) 四角定位图案（先画 7×7，再补分隔白边）
  const corners = [
    [0, 0],
    [n - FINDER_SIZE, 0],
    [n - FINDER_SIZE, n - FINDER_SIZE],
    [0, n - FINDER_SIZE],
  ];
  for (const [ox, oy] of corners) drawFinder(isFunction, funcColor, n, ox, oy);
  const reserveOrigins = [
    [0, 0],
    [n - RESERVE, 0],
    [n - RESERVE, n - RESERVE],
    [0, n - RESERVE],
  ];
  for (const [x0, y0] of reserveOrigins) drawSeparator(isFunction, funcColor, n, x0, y0);

  // 2) 方向块：左上黑、其余白 —— 用来消解 90° 旋转歧义
  const orientOrigins = [
    [ORIENT_OFF, ORIENT_OFF], // TL
    [n - ORIENT_OFF - ORIENT_SIZE, ORIENT_OFF], // TR
    [n - ORIENT_OFF - ORIENT_SIZE, n - ORIENT_OFF - ORIENT_SIZE], // BR
    [ORIENT_OFF, n - ORIENT_OFF - ORIENT_SIZE], // BL
  ];
  const orientationBlocks = orientOrigins.map(([ox, oy], corner) => {
    const cells = new Int32Array(ORIENT_SIZE * ORIENT_SIZE);
    let w = 0;
    for (let dy = 0; dy < ORIENT_SIZE; dy++) {
      for (let dx = 0; dx < ORIENT_SIZE; dx++) {
        const idx = (oy + dy) * n + (ox + dx);
        isFunction[idx] = 1;
        funcColor[idx] = corner === 0 ? 1 : 0;
        cells[w++] = idx;
      }
    }
    return cells;
  });

  // 3) 中心对齐图案（用于校验单应矩阵是否可信）
  const c = (n - 1) / 2;
  const a0 = c - 2;
  for (let dy = 0; dy < ALIGN_SIZE; dy++) {
    for (let dx = 0; dx < ALIGN_SIZE; dx++) {
      const black =
        dx === 0 || dx === 4 || dy === 0 || dy === 4 || (dx === 2 && dy === 2);
      const idx = (a0 + dy) * n + (a0 + dx);
      isFunction[idx] = 1;
      funcColor[idx] = black ? 1 : 0;
    }
  }

  // 4) 校准带：四条边上各一排已知颜色的格子
  const calibCells = [];
  const calibOrdinal = [];
  const end = n - CALIB_START - 1;
  let ord = 0;
  const pushCalib = (x, y) => {
    const idx = y * n + x;
    if (isFunction[idx]) return;
    isFunction[idx] = 1;
    calibCells.push(idx);
    calibOrdinal.push(ord++);
  };
  for (let x = CALIB_START; x <= end; x++) pushCalib(x, CALIB_OFF);
  for (let y = CALIB_START; y <= end; y++) pushCalib(n - 1 - CALIB_OFF, y);
  for (let x = end; x >= CALIB_START; x--) pushCalib(x, n - 1 - CALIB_OFF);
  for (let y = end; y >= CALIB_START; y--) pushCalib(CALIB_OFF, y);

  // 5) 剩下的都是可用格；帧头格从中等间隔抽取，摊到整幅图上
  const free = [];
  for (let i = 0; i < total; i++) if (!isFunction[i]) free.push(i);
  if (free.length < HEADER_CELLS + 256) {
    throw new Error(`版面 ${n} 太小，放不下帧头`);
  }
  const stride = Math.floor(free.length / HEADER_CELLS);
  const headerSet = new Set();
  const headerCells = new Int32Array(HEADER_CELLS);
  for (let i = 0; i < HEADER_CELLS; i++) {
    const idx = free[i * stride];
    headerCells[i] = idx;
    headerSet.add(idx);
  }
  const dataCells = Int32Array.from(free.filter((i) => !headerSet.has(i)));

  // 校验格：颜色已知的功能格（不含校准带，因为校准带的颜色随调色板变）
  // 接收端用它们快速判断「版面尺寸猜对没有」，猜错就不必做后面昂贵的 RS 解码
  const checkCells = [];
  const checkColor = [];
  const calibSet = new Set(calibCells);
  for (let i = 0; i < total; i++) {
    if (isFunction[i] && !calibSet.has(i)) {
      checkCells.push(i);
      checkColor.push(funcColor[i]);
    }
  }

  // 定位图案中心（格坐标，用「格中心 = 整数 + 0.5」）：顺时针 TL→TR→BR→BL
  const h = FINDER_SIZE / 2;
  const finderCenters = [
    [h, h],
    [n - h, h],
    [n - h, n - h],
    [h, n - h],
  ];

  const layout = {
    n,
    isFunction,
    funcColor,
    orientationBlocks,
    calibCells: Int32Array.from(calibCells),
    calibOrdinal: Int32Array.from(calibOrdinal),
    checkCells: Int32Array.from(checkCells),
    checkColor: Uint8Array.from(checkColor),
    headerCells,
    dataCells,
    finderCenters,
    alignCenter: [c + 0.5, c + 0.5],
  };
  layoutCache.set(n, layout);
  return layout;
}

/* ---------------- 容量 ---------------- */

/** 一帧数据区能装多少字节（RS 编码后的字节数）。 */
export function frameCapacityBytes(n, paletteName) {
  const layout = buildLayout(n);
  const p = paletteByName(paletteName);
  return Math.floor((layout.dataCells.length * p.bits) / 8);
}

/* ---------------- 一帧的编码 ---------------- */

/**
 * 把帧头和载荷画成一张 n×n 的 RGB 矩阵。
 * @param {number} n
 * @param {string} paletteName
 * @param {Uint8Array} headerCodeword 32 字节（16 数据 + 16 RS 校验）
 * @param {Uint8Array} payload 已 RS 编码 + 交织的载荷
 * @returns {Uint8Array} 长度 n*n*3
 */
export function paintFrame(n, paletteName, headerCodeword, payload) {
  const layout = buildLayout(n);
  const pal = paletteByName(paletteName);
  const rgb = new Uint8Array(n * n * 3);

  const setCell = (idx, color) => {
    rgb[idx * 3] = color[0];
    rgb[idx * 3 + 1] = color[1];
    rgb[idx * 3 + 2] = color[2];
  };
  const BLACK = [0, 0, 0];
  const WHITE = [255, 255, 255];

  // 功能图案（含分隔白边、方向块、对齐图案）
  for (let i = 0; i < n * n; i++) {
    if (layout.isFunction[i]) setCell(i, layout.funcColor[i] ? BLACK : WHITE);
  }
  // 校准带
  const P = pal.colors.length;
  for (let i = 0; i < layout.calibCells.length; i++) {
    setCell(layout.calibCells[i], pal.colors[layout.calibOrdinal[i] % P]);
  }
  // 帧头：固定黑白 1bit
  const hr = new BitReader(headerCodeword);
  for (let i = 0; i < layout.headerCells.length; i++) {
    setCell(layout.headerCells[i], hr.read(1) ? BLACK : WHITE);
  }
  // 数据区
  const dr = new BitReader(payload);
  const bits = pal.bits;
  const capBits = payload.length * 8;
  for (let i = 0; i < layout.dataCells.length; i++) {
    const v = dr.bitPos + bits <= capBits ? dr.read(bits) : 0;
    setCell(layout.dataCells[i], pal.colors[v]);
  }
  return rgb;
}

/* ---------------- 从「每格的调色板下标」还原字节 ---------------- */

export function headerBitsToBytes(bits) {
  const w = new BitWriter(HEADER_DATA_BYTES + HEADER_NSYM);
  for (let i = 0; i < bits.length; i++) w.write(bits[i], 1);
  return w.bytes;
}

export function dataIndicesToBytes(indices, bitsPerCell) {
  const w = new BitWriter(Math.floor((indices.length * bitsPerCell) / 8));
  const capBits = w.bytes.length * 8;
  for (let i = 0; i < indices.length; i++) {
    if (w.bitPos + bitsPerCell > capBits) break;
    w.write(indices[i], bitsPerCell);
  }
  return w.bytes;
}
