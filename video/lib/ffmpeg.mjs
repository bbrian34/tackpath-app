// ffmpeg: $FFMPEG, else the one on PATH, else ffmpeg-static from npm
// (render.sh installs it into video/node_modules when no ffmpeg is found).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

function find() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return 'ffmpeg'; } catch (e) {}
  try { return createRequire(import.meta.url)('ffmpeg-static'); } catch (e) {}
  throw new Error('ffmpeg not found: install it, or run video/render.sh (it installs ffmpeg-static)');
}
export const FFMPEG = find();
export const FFPROBE = process.env.FFPROBE || FFMPEG.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
