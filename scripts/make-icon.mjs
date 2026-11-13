// 生成 1024x1024 应用图标源图（圆角蓝底 + 白色对话气泡 + 信封折线），然后运行 `npx tauri icon app-icon.png`
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const N = 1024;
const px = Buffer.alloc(N * N * 4);
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const i = (y * N + x) * 4;
    if (!inRoundRect(x, y, 0, 0, N - 1, N - 1, 220)) continue;
    let [r, g, b] = [42 + (y / N) * 20, 150 - (y / N) * 40, 238];
    const bubble = inRoundRect(x, y, 200, 260, 824, 700, 90);
    const tail = x > 280 && x < 420 && y >= 690 && y < 820 && x - 280 > (y - 690) * 0.9;
    if (bubble || tail) [r, g, b] = [255, 255, 255];
    // 信封的 V 形折线
    if (bubble && y < 560) {
      const v = y - 300 - (312 - Math.abs(x - 512)) * 0.62;
      if (Math.abs(v) < 16) [r, g, b] = [42, 120, 238];
    }
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
}

const stride = N * 4 + 1;
const raw = Buffer.alloc(stride * N);
for (let y = 0; y < N; y++) px.copy(raw, y * stride + 1, y * N * 4, (y + 1) * N * 4);

const crcTable = Array.from({ length: 256 }, (_, n) => {
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
