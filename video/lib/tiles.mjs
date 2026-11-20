// Illustrative map tiles for the video (OpenStreetMap is not reachable from the
// render machine). A plain, generic street grid drawn here: light blocks, white
// streets, a few wider avenues and parks. It is NOT a real map of any place;
// the video does not label it as OpenStreetMap.
import zlib from 'node:zlib';

function png(w, h, px) {               // px: Uint8Array RGBA
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const hash = (a, b) => { let x = (a * 374761393 + b * 668265263) | 0; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };

// world-pixel based, so streets continue across tiles at every zoom
export function tile(z, x, y) {
  const S = 256, px = new Uint8Array(S * S * 4);
  const set = (i, c) => { px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255; };
  const scale = Math.pow(2, z - 15);          // street spacing in world pixels at z15
  const minor = 46 * scale, major = 46 * 6 * scale;
  const block = [236, 234, 229], street = [255, 255, 255], avenue = [252, 230, 160], park = [205, 230, 196], edge = [214, 211, 204];
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const wx = x * S + i, wy = y * S + j, k = (j * S + i) * 4;
    const gx = Math.floor(wx / minor), gy = Math.floor(wy / minor);
    const fx = wx - gx * minor, fy = wy - gy * minor;
    const sw = Math.max(1.2, 4 * scale);
    const onMajorX = Math.abs(wx - Math.round(wx / major) * major) < Math.max(2, 7 * scale);
    const onMajorY = Math.abs(wy - Math.round(wy / major) * major) < Math.max(2, 7 * scale);
    if (minor >= 6 && (onMajorX || onMajorY)) { set(k, avenue); continue; }
    if (minor >= 6 && (fx < sw || fy < sw)) { set(k, street); continue; }
    if (minor >= 6 && (fx < sw + 1 || fy < sw + 1)) { set(k, edge); continue; }
    set(k, hash(gx, gy) < 0.07 ? park : block);
  }
  return png(S, S, px);
}
