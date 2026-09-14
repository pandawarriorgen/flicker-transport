// 把 n×n 的 RGB 矩阵铺成像素。纯计算，无 DOM 依赖（Node 自测也用它）。

/**
 * @param {Uint8Array} rgb 长度 n*n*3
 * @param {number} n
 * @param {number} cellPx 每格几个像素
 * @param {number} quiet 四周留白格数（定位图案需要静默区，别小于 2）
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function rasterize(rgb, n, cellPx = 1, quiet = 3) {
  const cells = n + quiet * 2;
  const size = cells * cellPx;
  const data = new Uint8ClampedArray(size * size * 4);
  data.fill(255); // 静默区为白

  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const s = (cy * n + cx) * 3;
      const r = rgb[s];
      const g = rgb[s + 1];
      const b = rgb[s + 2];
      const px0 = (cx + quiet) * cellPx;
      const py0 = (cy + quiet) * cellPx;
      for (let dy = 0; dy < cellPx; dy++) {
        let o = ((py0 + dy) * size + px0) * 4;
        for (let dx = 0; dx < cellPx; dx++) {
          data[o] = r;
          data[o + 1] = g;
          data[o + 2] = b;
          data[o + 3] = 255;
          o += 4;
        }
      }
    }
  }
  return { data, width: size, height: size };
}
