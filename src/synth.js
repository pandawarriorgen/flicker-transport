// 造假摄像头：把渲染好的码图做透视、模糊、光照不均、噪声，
// 用来在没有真摄像头的情况下压测识别流程。

/** 由四个角点构造「单位正方形 → 四边形」的 3×3 矩阵。 */
function squareToQuadMatrix(q) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dy1 * dx2;
  const g = (dx3 * dy2 - dy3 * dx2) / det;
  const h = (dx1 * dy3 - dy1 * dx3) / det;
  return [
    [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x],
    [p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y],
    [g, h, 1],
  ];
}

function invert3x3(m) {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

function bilinear(src, sw, sh, x, y, out) {
  if (x < 0 || y < 0 || x > sw - 1 || y > sh - 1) {
    out[0] = out[1] = out[2] = 30; // 画面外当成暗背景
    return;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(sw - 1, x0 + 1);
  const y1 = Math.min(sh - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  for (let ch = 0; ch < 3; ch++) {
    const p00 = src[(y0 * sw + x0) * 4 + ch];
    const p10 = src[(y0 * sw + x1) * 4 + ch];
    const p01 = src[(y1 * sw + x0) * 4 + ch];
    const p11 = src[(y1 * sw + x1) * 4 + ch];
    out[ch] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
  }
}

function boxBlur(data, w, h, radius) {
  if (radius <= 0) return data;
  const tmp = new Float32Array(w * h * 3);
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const o = (y * w + xx) * 4;
        r += data[o];
        g += data[o + 1];
        b += data[o + 2];
        c++;
      }
      const t = (y * w + x) * 3;
      tmp[t] = r / c;
      tmp[t + 1] = g / c;
      tmp[t + 2] = b / c;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const t = (yy * w + x) * 3;
        r += tmp[t];
        g += tmp[t + 1];
        b += tmp[t + 2];
        c++;
      }
      const o = (y * w + x) * 4;
      out[o] = r / c;
      out[o + 1] = g / c;
      out[o + 2] = b / c;
      out[o + 3] = 255;
    }
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {{data:Uint8ClampedArray,width:number,height:number}} raster 渲染好的码图
 * @param {object} opts
 * @returns {{data:Uint8ClampedArray,width:number,height:number}}
 */
export function simulateCamera(raster, opts = {}) {
  const {
    outW = 960,
    outH = 540,
    perspective = 0.06, // 倾斜程度（相对画面宽度）
    scale = 0.82, // 码图占画面高度的比例
    offsetX = 0,
    offsetY = 0,
    blur = 1,
    noise = 6,
    vignette = 0.35, // 四角变暗
    gamma = 1.0,
    colorGain = [1, 1, 1], // 摄像头白平衡偏色
    rotate90 = 0,
    seed = 12345,
  } = opts;

  const rand = mulberry32(seed);
  const side = Math.min(outW, outH) * scale;
  const cx = outW / 2 + offsetX;
  const cy = outH / 2 + offsetY;
  const half = side / 2;
  const px = perspective * outW;

  // 四角各推一点，制造透视
  let quad = [
    { x: cx - half + px * 0.6, y: cy - half + px * 0.3 },
    { x: cx + half + px * 0.2, y: cy - half - px * 0.5 },
    { x: cx + half - px * 0.7, y: cy + half + px * 0.1 },
    { x: cx - half - px * 0.1, y: cy + half - px * 0.4 },
  ];
  for (const p of quad) {
    p.x += (rand() - 0.5) * px * 0.4;
    p.y += (rand() - 0.5) * px * 0.4;
  }
  for (let r = 0; r < ((rotate90 % 4) + 4) % 4; r++) quad = [quad[3], quad[0], quad[1], quad[2]];

  const M = squareToQuadMatrix(quad);
  const Mi = invert3x3(M);

  const out = new Uint8ClampedArray(outW * outH * 4);
  const rgb = [0, 0, 0];
  const maxR = Math.hypot(outW / 2, outH / 2);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const wz = Mi[2][0] * x + Mi[2][1] * y + Mi[2][2];
      const u = (Mi[0][0] * x + Mi[0][1] * y + Mi[0][2]) / wz;
      const v = (Mi[1][0] * x + Mi[1][1] * y + Mi[1][2]) / wz;
      const o = (y * outW + x) * 4;
      if (u < 0 || u > 1 || v < 0 || v > 1) {
        out[o] = out[o + 1] = out[o + 2] = 28;
        out[o + 3] = 255;
        continue;
      }
      bilinear(raster.data, raster.width, raster.height, u * (raster.width - 1), v * (raster.height - 1), rgb);
      const rr = Math.hypot(x - outW / 2, y - outH / 2) / maxR;
      const vig = 1 - vignette * rr * rr;
      for (let ch = 0; ch < 3; ch++) {
        let val = rgb[ch] / 255;
        if (gamma !== 1) val = Math.pow(val, gamma);
        val = val * vig * colorGain[ch] * 255;
        out[o + ch] = val;
      }
      out[o + 3] = 255;
    }
  }

  const blurred = boxBlur(out, outW, outH, blur);
  if (noise > 0) {
    for (let i = 0; i < blurred.length; i += 4) {
      const nz = (rand() - 0.5) * 2 * noise;
      blurred[i] += nz;
      blurred[i + 1] += nz;
      blurred[i + 2] += nz;
    }
  }
  return { data: blurred, width: outW, height: outH };
}
