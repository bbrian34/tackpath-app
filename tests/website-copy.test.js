const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Public website copy (index.html), "delivery options" section (2026-10):
// eyebrow "DELIVERY OPTIONS", heading "Single deliveries and multi-stop
// routes." Text only: the section's markup (classes, the line break, the
// serif accent on the last word) and every other heading stay as they were.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
const text = (s) => s.replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const headings = () => Array.from(HTML.matchAll(/<h([12])[^>]*>([\s\S]*?)<\/h\1>/g)).map((m) => text(m[2]));

test('the delivery options section has the new eyebrow and heading', () => {
  assert.match(HTML, /<p class="eyebrow">DELIVERY OPTIONS<\/p><h2>Single deliveries<br>and multi-stop <span class="serif">routes\.<\/span><\/h2>/,
    'same markup, new words');
  assert.ok(headings().includes('Single deliveries and multi-stop routes.'));
  assert.match(HTML, /routes\.<\/span><\/h2><\/div><p>Run on-demand deliveries and multi-stop routes from the same dispatch desk, with the same drivers and the same view of the day\.<\/p>/,
    'the supporting text is unchanged');
});

test('the old wording is gone from the site', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..')).filter((n) => n.endsWith('.html'))) {
    const h = fs.readFileSync(path.join(__dirname, '..', f), 'utf-8');
    assert.ok(!/TWO WAYS TO DELIVER/i.test(h), f + ': old eyebrow');
    assert.ok(!/One delivery\.(<br>|\s)*Or a whole/i.test(h), f + ': old heading');
  }
});

test('every other heading on the page is unchanged', () => {
  assert.deepStrictEqual(headings().filter((t) => t !== 'Single deliveries and multi-stop routes.'), [
    'Every moving part. One clear path.',
    'Your operation, working together.',
    'The right tools. For each team.',
    'The last mile has a lot of moving parts.',
    'Local sellers are still shipping in days.',
    'Keep your customers in the loop.',
    'See what changed. Decide what comes next. Keep the day moving.',
    'Start small. Run big.',
    'Let’s make it clear.',
    'Your operation. A clearer next move.',
    'Your operation. A clearer path.',
  ]);
  assert.strictEqual(headings().length, 12, 'same number of headings');
  assert.match(HTML, /<title>TackPath \| Warehouse, routes, drivers, dispatch\.<\/title>/, 'title unchanged');
});
