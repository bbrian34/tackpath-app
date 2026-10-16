// Opens a headless Chromium for the layout tests (jsdom has no layout).
// Tries, in order: CHROME_PATH, the Chromium Playwright keeps in
// PLAYWRIGHT_BROWSERS_PATH (or /opt/pw-browsers), installed Chrome, then
// Edge (always present on Windows). Same file in both repos.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

function bundled() {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  try {
    return fs.readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()
      .map((d) => path.join(dir, d, 'chrome-linux', 'chrome')).find((p) => fs.existsSync(p));
  } catch (e) { return undefined; }
}

async function launch(args) {
  const tries = [];
  if (process.env.CHROME_PATH) tries.push({ executablePath: process.env.CHROME_PATH });
  const b = bundled(); if (b) tries.push({ executablePath: b });
  tries.push({ channel: 'chrome' }, { channel: 'msedge' });
  let last;
  for (const t of tries) {
    try { return await chromium.launch(Object.assign({ args: args || [] }, t)); } catch (e) { last = e; }
  }
  throw new Error('No Chromium, Chrome or Edge found for the layout tests; set CHROME_PATH. ' + (last && last.message));
}

module.exports = { launch };
