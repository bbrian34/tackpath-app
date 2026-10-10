const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { launch } = require('./browser');

// PathIQ STAGE step size (2026-10-11): on the TC56 (360x640 CSS px) the
// STAGE panel, and the staged confirmation after it, must be the BIN step's
// size with the BIN step's heading and line sizes, in its own colour, and
// nothing may spill out of it. Measured in a real browser (jsdom has no
// layout). STOW_HTML overrides the page under test.

const FILE = process.env.STOW_HTML || path.join(__dirname, '..', 'stow.html');

test('STAGE and staged panels are the same size and type scale as the BIN panel on the TC56', async () => {
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 640 } });
    const p = await ctx.newPage();
    await p.route(/^https?:\/\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await p.addInitScript(() => { try { localStorage.setItem('tp_dispatch_org', JSON.stringify({ id: 'o', slug: 's', name: 'N', token: 't' })); localStorage.setItem('tp_worker', 'K'); } catch (e) {} });
    await p.goto('file://' + FILE);
    await p.waitForTimeout(500);
    const out = {};
    for (const mode of ['bin', 'stage', 'staged']) {
      await p.evaluate((mode) => {
        goTo('stow'); stageTarget = null; stageConfirm = null; pendingPlacement = null;
        if (mode === 'bin') {
          pendingPlacement = { binNum: '3A', location: 'A-03', code: 'PCX1', jobTitle: 'Surge Route RT-003', stopNum: 3, pieceKey: 'PCX1', required: 1 };
          document.getElementById('flipBinNumber').textContent = 'BIN 3A'; document.getElementById('flipBinLoc').textContent = 'Location A-03';
          document.getElementById('flipBinInstr').textContent = 'SCAN BIN OR LOCATION'; document.getElementById('flipBinStop').textContent = 'STOP 3';
          document.getElementById('scanFlipInner').classList.add('flipped');
        } else if (mode === 'stage') stageTarget = { jobId: 'j', bin: '3A', title: 'Surge Route RT-003', ready: null };
        else stageConfirm = { spot: 'S-03', bin: '3A', title: 'Surge Route RT-003', until: Date.now() + 60000 };
        renderStowSteps();
      }, mode);
      await p.waitForTimeout(800);   // the flip animation
      out[mode] = await p.evaluate(() => {
        const box = (e) => { const r = e.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); };
        const c = document.getElementById('scanFlipContainer'), back = document.querySelector('#scanFlipInner .flip-card-back');
        const f = (id) => { const cs = getComputedStyle(document.getElementById(id)); return cs.fontSize + ' ' + cs.fontWeight; };
        return { container: box(c), back: box(back), colour: getComputedStyle(back).backgroundColor,
          overflow: back.scrollHeight > back.clientHeight + 1 || back.scrollWidth > back.clientWidth + 1,
          heading: f('flipBinNumber'), loc: f('flipBinLoc'), instr: f('flipBinInstr'),
          text: back.textContent.replace(/\s+/g, ' ').trim(), pageOverflowX: document.documentElement.scrollWidth > innerWidth };
      });
    }
    for (const mode of ['stage', 'staged']) {
      const s = out[mode], b = out.bin;
      assert.strictEqual(s.container, b.container, mode + ' panel size equals the BIN panel');
      assert.strictEqual(s.back, b.back, mode + ' face size equals the BIN face');
      assert.strictEqual(s.heading, b.heading, mode + ' heading size');
      assert.strictEqual(s.loc, b.loc, mode + ' line size');
      assert.strictEqual(s.instr, b.instr, mode + ' line size');
      assert.ok(!s.overflow, mode + ': nothing spills out of the panel');
      assert.ok(!s.pageOverflowX, mode + ': no sideways scroll');
    }
    assert.notStrictEqual(out.stage.colour, out.bin.colour, 'STAGE keeps its own (amber) colour');
    assert.match(out.stage.text, /STAGE/i, 'the STAGE step is still shown');
    await ctx.close();
  } finally { await browser.close(); }
});
