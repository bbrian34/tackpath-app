// What the phone camera "sees" in the recording: a still of a package label
// (made up, no real tracking number), fed to Chromium as its fake camera, in
// place of Chromium's own green test pattern. Written to work/camera.y4m.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './apps.mjs';

// Deterministic bars that look like a barcode (decorative, not decodable).
function bars() {
  let x = 0, s = 7, out = '';
  while (x < 520) { s = (s * 9301 + 49297) % 233280; const w = 3 + (s % 4) * 3; if ((s >> 3) % 2) out += `<rect x="${x}" y="0" width="${w}" height="150"/>`; x += w; }
  return out;
}
const HTML = `<!doctype html><html><body style="margin:0;width:640px;height:480px;background:radial-gradient(circle at 40% 35%,#c99a62,#8e6438);display:flex;align-items:center;justify-content:center;font-family:Arial,Helvetica,sans-serif">
<div style="background:#fbfbf7;width:470px;padding:22px 26px;border-radius:6px;box-shadow:0 10px 30px rgba(0,0,0,.35);transform:rotate(-2deg)">
<div style="font-weight:900;font-size:28px;letter-spacing:3px;color:#111">QUICK HAUL</div>
<div style="font-size:16px;color:#333;margin:4px 0 14px">Same-day delivery &middot; Marietta, GA</div>
<svg width="418" height="130" viewBox="0 0 520 150" preserveAspectRatio="none" fill="#111">${bars()}</svg>
<div style="height:10px"></div></div></body></html>`;

export async function makeCamera(work, ffmpeg) {
  const png = path.join(work, 'camera.png'), y4m = path.join(work, 'camera.y4m');
  if (fs.existsSync(y4m)) return y4m;
  fs.mkdirSync(work, { recursive: true });
  const b = await launch();
  const p = await (await b.newContext({ viewport: { width: 640, height: 480 } })).newPage();
  await p.setContent(HTML); await p.screenshot({ path: png }); await b.close();
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-t', '2', '-r', '15', '-pix_fmt', 'yuv420p', y4m]);
  return y4m;
}
