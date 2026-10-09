// WCAG AA check of the dispatcher's light-theme colour variables.
// Reads the html[data-theme="light"] block from dispatcher.html, then checks
// every text colour against every surface it is used on, accent text on its
// own tinted chip/badge backgrounds, and white text on the solid accent
// buttons. Prints each pair below 4.5:1 and exits 1 if there is any.
//
//   node tests/visual/theme-contrast.mjs            (failures only)
//   node tests/visual/theme-contrast.mjs --all      (every pair)
//
// The page-level check (every piece of visible text on every screen) is
// node tests/visual/dispatcher-theme.mjs --theme light --scan
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../../dispatcher.html', import.meta.url), 'utf8');
const block = html.match(/html\[data-theme="light"\]\{([\s\S]*?)\n\}/);
if (!block) { console.error('light theme block not found'); process.exit(2); }
const v = {};
for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) v[m[1]] = m[2].trim();

const parse = (c) => {
  c = c.trim();
  let m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (m) { const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]; return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1); }
  m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
  throw new Error('cannot read colour ' + c);
};
const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
const lum = (c) => 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
function ch(x) { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = (c) => '#' + c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

const surfaces = ['--bg', '--card', '--card2', '--card3'];
const accents = { blue: '--blue', green: '--green', green2: '--green', orange: '--orange', red: '--red', yellow: '--yellow', purple: '--purple' };
const texts = ['--text', '--muted', '--faint', ...new Set(Object.values(accents)),
  ...Object.keys(v).filter((k) => k.startsWith('--lt-fg-') && !['--lt-fg-hex-00230f'].includes(k))];

// tints that never have text on them: the pipeline scrollbar thumb (.35, hover .55) and the analytics bars (.vb, .28)
const NO_TEXT = ['--lt-bg-blue-28', '--lt-bg-blue-35', '--lt-bg-blue-55'];
const rows = [];
const check = (label, fg, bg, need = 4.5) => {
  const b = parse(bg), f = over(parse(fg), b), r = ratio(f, b);
  rows.push({ label, fg: hex(f), bg: hex(b), r, need });
};
// 1. every text colour on every page surface
for (const t of texts) for (const s of surfaces) check(`${t} on ${s}`, v[t], v[s]);
// 2. accent text on its own tint (chips, badges, counters), laid over a card and a grey card
for (const [fam, text] of Object.entries(accents)) {
  for (const tint of Object.keys(v).filter((k) => k.startsWith(`--lt-bg-${fam}-`) && !/-(grid|glow|splash)$/.test(k) && !NO_TEXT.includes(k))) {
    for (const s of ['--card', '--card2']) check(`${text} on ${tint} over ${s}`, v[text], hex(over(parse(v[tint]), parse(v[s]))));
  }
}
check('--lt-fg-green-5 (delivered chip) on --lt-bg-green-04 over --card', v['--lt-fg-green-5'], hex(over(parse(v['--lt-bg-green-04']), parse(v['--card']))));
// 3. white text on solid accent buttons, bubbles and badges
const solids = ['--blue', '--green', '--red', '--purple', '--orange',
  ...Object.keys(v).filter((k) => /^--lt-bg-hex-(0aa8ff|005fcc|0060cc|005faa|19b7ef|53ff88|16803a|8d5cff|95bf47|ff6363)$/.test(k))];
for (const s of solids) check(`#ffffff on ${s}`, '#ffffff', v[s]);
// 4. dark text kept on the green "current stop" badge becomes white
check('--lt-fg-hex-00230f on --green', v['--lt-fg-hex-00230f'], v['--green']);
// 5. the chat bubble from drivers
check('--lt-fg-hex-111-bubble on --lt-bg-hex-e5e5ea-bubble', v['--lt-fg-hex-111-bubble'], v['--lt-bg-hex-e5e5ea-bubble']);

const fails = rows.filter((x) => x.r + 1e-9 < x.need);
for (const x of (process.argv.includes('--all') ? rows : fails)) {
  console.log(`${x.r < x.need ? 'FAIL' : 'ok  '} ${x.r.toFixed(2).padStart(5)}:1 (need ${x.need})  ${x.fg} on ${x.bg}  ${x.label}`);
}
console.log(`${rows.length} light-theme colour pairs checked, ${fails.length} below WCAG AA`);
process.exitCode = fails.length ? 1 : 0;
