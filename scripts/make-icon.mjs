// 生成 1024x1024 MailChat 应用主图标源图（C2 中心对称 45° 双折面 · 清透冷瓷白超椭圆 + #0F172A 深石板折面 + #3563E9 信号蓝圆点）
// 生成后运行：`node scripts/run-tauri.mjs icon app-icon.png`
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const N = 1024;
const px = Buffer.alloc(N * N * 4);

// 将像素坐标映射到 256x256 几何制图空间
// 连续曲率超椭圆（Squircle）：中心 (128, 128)，半轴 R，指数 p = 4.6
function squircleSignedDist(ux, uy, radius) {
  const dx = Math.abs(ux - 128) / radius;
  const dy = Math.abs(uy - 128) / radius;
  const p = 4.6;
  const norm = Math.pow(Math.pow(dx, p) + Math.pow(dy, p), 1 / p);
  return (norm - 1) * radius;
}

// C2 中心对称 45° 双折面（严格锁定于 [70..186] 4x29px 基准网格）
function inLeftPlane(ux, uy) {
  return ux <= 128 && ux + uy >= 198 && uy - ux <= 58 && ux + uy <= 256;
}

function inRightPlane(ux, uy) {
  return ux >= 128 && ux + uy <= 314 && ux - uy <= 58 && ux + uy >= 256;
}

function sampleSubpixel(ux, uy) {
  const dOuter = squircleSignedDist(ux, uy, 108);
  if (dOuter > 0) return [0, 0, 0, 0];

  // 清透冷瓷白主体：自上而下极轻微过渡 (#FFFFFF -> #F6F8FC)，对齐项目 --surface-main / --surface-list
  const t = Math.min(1, Math.max(0, (uy - 20) / 216));
  let r = 255 - t * 9;
  let g = 255 - t * 7;
  let b = 255 - t * 3;

  // 外缘 1.5px 冷雾蓝细描边 (#DCE4F0)
  if (dOuter > -1.5) {
    r = 220;
    g = 228;
    b = 240;
  } else {
    // 内圈倒角微刻线 (R = 103, #EEF3FA)
    const dRim = Math.abs(squircleSignedDist(ux, uy, 103));
    if (dRim < 0.55) {
      r = 238;
      g = 243;
      b = 250;
    }
  }

  // 右上角项目主题蓝 (#3563E9) 信号圆点：中心 (178.5, 77.5)，半径 8.5
  const dxDot = ux - 178.5;
  const dyDot = uy - 77.5;
  if (dxDot * dxDot + dyDot * dyDot <= 8.5 * 8.5) {
    return [53, 99, 233, 255];
  }

  // C2 中心对称双折面：项目主墨色深石板蓝黑 (#0F172A)
  if (inLeftPlane(ux, uy) || inRightPlane(ux, uy)) {
    return [15, 23, 42, 255];
  }

  return [r, g, b, 255];
}

// 4x4 超采样抗锯齿 (16x SSAA)
const OFFSETS = [-0.375, -0.125, 0.125, 0.375];
const SCALE = 256 / N;

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sa = 0;

    for (let oy = 0; oy < 4; oy++) {
      const uy = (y + 0.5 + OFFSETS[oy]) * SCALE;
      for (let ox = 0; ox < 4; ox++) {
        const ux = (x + 0.5 + OFFSETS[ox]) * SCALE;
        const [r, g, b, a] = sampleSubpixel(ux, uy);
        if (a > 0) {
          sr += r * a;
          sg += g * a;
          sb += b * a;
          sa += a;
        }
      }
    }

    const i = (y * N + x) * 4;
    if (sa > 0) {
      px[i] = Math.round(sr / sa);
      px[i + 1] = Math.round(sg / sa);
      px[i + 2] = Math.round(sb / sa);
      px[i + 3] = Math.round(sa / 16);
    }
  }
}

const stride = N * 4 + 1;
const raw = Buffer.alloc(stride * N);
for (let y = 0; y < N; y++) {
  px.copy(raw, y * stride + 1, y * N * 4, (y + 1) * N * 4);
}

const crcTable = Array.from({ length: 256, }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

writeFileSync(
  process.argv[2] ?? "app-icon.png",
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
