// Inlines tools/driver-loadcheck.js into a driver page (driver.html, or the phone app's www/index.html),
// as the last script before </body>, between the TP-LOADCHECK markers (replaced if already there).
import fs from 'node:fs';
const [page] = process.argv.slice(2);
const js = fs.readFileSync(new URL('./driver-loadcheck.js', import.meta.url), 'utf8');
let html = fs.readFileSync(page, 'utf8');
const block = `<!-- TP-LOADCHECK (generated from tools/driver-loadcheck.js; edit that file and run tools/inline-loadcheck.mjs) -->\n<script>\n${js}</script>\n<!-- /TP-LOADCHECK -->\n`;
const a = html.indexOf('<!-- TP-LOADCHECK'), b = html.indexOf('<!-- /TP-LOADCHECK -->');
if (a >= 0 && b > a) html = html.slice(0, a) + block + html.slice(b + '<!-- /TP-LOADCHECK -->\n'.length);
else { const end = html.lastIndexOf('</body>'); if (end < 0) throw new Error('no </body>'); html = html.slice(0, end) + block + html.slice(end); }
fs.writeFileSync(page, html);
console.log('inlined into', page);
