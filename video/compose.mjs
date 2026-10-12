// Compose: work/shots.json + screenshots -> one 1920x1080 frame per shot
// (stage.html), then ffmpeg crossfades them on the storyboard's timeline into
// out/tackpath-demo.mp4 (H.264, 30 fps) and writes out/scenes.txt.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from './lib/apps.mjs';
import { FFMPEG, FFPROBE } from './lib/ffmpeg.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = path.join(HERE, 'work'), FRAMES = path.join(WORK, 'frames'), OUT = path.join(HERE, 'out');
fs.rmSync(FRAMES, { recursive: true, force: true }); fs.mkdirSync(FRAMES, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });

// The storyboard: when each scene starts (seconds), and the total.
const START = { 1: 0, 2: 10, 3: 30, 4: 50, 5: 85, 6: 100, 7: 125, 8: 150, 9: 170 };
// Fades: a short one between shots of a scene, a longer one between scenes.
const TOTAL = 180, FADE_SHOT = 0.3, FADE_SCENE = 0.6, FPS = 30;

const { shots: all } = JSON.parse(fs.readFileSync(path.join(WORK, 'shots.json'), 'utf8'));
const captions = {}; for (const m of all) if (m.kind === 'mark') captions[m.scene] = m.caption;
const shots = all.filter((s) => s.kind === 'shot').map((s) => Object.assign({ caption: captions[s.scene] }, s));

// Times: each scene's span is shared by its shots in proportion to their weight w.
const scenes = Object.keys(START).map(Number);
for (const sc of scenes) {
  const list = shots.filter((s) => s.scene === sc);
  if (!list.length) throw new Error('scene ' + sc + ' has no shots');
  const end = START[sc + 1] != null ? START[sc + 1] : TOTAL;
  const W = list.reduce((a, s) => a + (s.w || 1), 0);
  let t = START[sc];
  for (const s of list) { s.t = +t.toFixed(3); t += (end - START[sc]) * (s.w || 1) / W; }
}

// Frames
const browser = await launch(['--force-color-profile=srgb', '--font-render-hinting=none']);
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
await page.goto('file://' + path.join(HERE, 'stage.html'));
for (const [i, s] of shots.entries()) {
  const img = {}; for (const k in s.img || {}) img[k] = 'work/shots/' + s.img[k];
  await page.evaluate((x) => window.render(x), Object.assign({}, s, { img }));
  await page.evaluate(() => Promise.all(Array.from(document.images).map((im) => im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; }))));
  const text = await page.evaluate(() => document.body.innerText);
  if (/\u2014/.test(text)) throw new Error('long dash in frame ' + i);
  s.frame = path.join(FRAMES, String(i).padStart(3, '0') + '.png');
  await page.screenshot({ path: s.frame });
}
await browser.close();
if (process.env.FRAMES_ONLY) { console.log('[compose] frames in', FRAMES); process.exit(0); }

// Video: clip i is fully on screen from s.t; the fade into it (s.fade) ends there.
shots.forEach((s, i) => { s.fade = i === 0 ? 0 : (s.scene !== shots[i - 1].scene ? FADE_SCENE : FADE_SHOT); });
const args = ['-y', '-loglevel', 'error'];
shots.forEach((s, i) => {
  const len = i + 1 < shots.length ? shots[i + 1].t - s.t + shots[i + 1].fade + s.fade : TOTAL - s.t + s.fade;
  args.push('-loop', '1', '-framerate', String(FPS), '-t', len.toFixed(3), '-i', s.frame);
});
const f = [];
shots.forEach((s, i) => f.push(`[${i}:v]format=yuv420p,setsar=1[v${i}]`));
let last = 'v0';
for (let i = 1; i < shots.length; i++) {
  const o = i === shots.length - 1 ? 'vout' : 'x' + i;
  f.push(`[${last}][v${i}]xfade=transition=fade:duration=${shots[i].fade}:offset=${(shots[i].t - shots[i].fade).toFixed(3)}[${o}]`);
  last = o;
}
const mp4 = path.join(OUT, 'tackpath-demo.mp4');
fs.writeFileSync(path.join(WORK, 'filter.txt'), f.join(';\n'));
args.push('-filter_complex_script', path.join(WORK, 'filter.txt'), '-map', '[' + last + ']', '-t', String(TOTAL),
  '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
  '-profile:v', 'high', '-movflags', '+faststart', mp4);
execFileSync(FFMPEG, args, { stdio: 'inherit' });

// Report
let dur = '';
try { dur = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mp4]).toString().trim(); } catch (e) {}
const mmss = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
const lines = scenes.map((sc) => `${sc}. ${mmss(START[sc])}  ${captions[sc]}`);
fs.writeFileSync(path.join(OUT, 'scenes.txt'), lines.join('\n') + '\n');
console.log('[compose]', mp4, (fs.statSync(mp4).size / 1048576).toFixed(1) + ' MB', dur ? dur + ' s' : '');
console.log(lines.join('\n'));
