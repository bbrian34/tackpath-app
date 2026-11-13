// Inlines tools/driver-calm.js (less clutter at a stop) into a driver page (driver.html, or the phone app's www/index.html),
// as the last script before </body>, between the TP-CALM markers (replaced if already there).
import fs from 'node:fs';
const [page] = process.argv.slice(2);
const js = fs.readFileSync(new URL('./driver-calm.js', import.meta.url), 'utf8');
let html = fs.readFileSync(page, 'utf8');
const block = `<!-- TP-CALM (generated from tools/driver-calm.js; edit that file and run tools/inline-calm.mjs) -->\n<script>\n${js}</script>\n<!-- /TP-CALM -->\n`;
const a = html.indexOf('<!-- TP-CALM'), b = html.indexOf('<!-- /TP-CALM -->');
if (a >= 0 && b > a) html = html.slice(0, a) + block + html.slice(b + '<!-- /TP-CALM -->\n'.length);
else { const end = html.lastIndexOf('</body>'); if (end < 0) throw new Error('no </body>'); html = html.slice(0, end) + block + html.slice(end); }
fs.writeFileSync(page, html);
console.log('inlined into', page);
