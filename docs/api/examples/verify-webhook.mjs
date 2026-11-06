// Receiving TackPath webhooks in Node.js (18+), no dependencies.
//   TACKPATH_WEBHOOK_SECRET=whsec_... node verify-webhook.mjs
// Verify the signature on the RAW body, reject old timestamps (replay), ignore
// event ids you have already processed, answer 2xx quickly, work afterwards.
import http from 'node:http';
import crypto from 'node:crypto';

export function verifyTackPathSignature(secret, rawBody, header, toleranceSeconds = 300, now = Date.now()) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false;              // too old: possible replay
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const seen = new Set();   // use your database in production
if (import.meta.url === `file://${process.argv[1]}`) {
  http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!verifyTackPathSignature(process.env.TACKPATH_WEBHOOK_SECRET, raw, req.headers['tackpath-signature'])) {
        res.writeHead(400).end('bad signature'); return;
      }
      const event = JSON.parse(raw);
      res.writeHead(200).end('ok');                       // acknowledge first
      if (seen.has(event.id)) return;                      // a retry of an event already handled
      seen.add(event.id);
      console.log(event.type, event.data.order ? `${event.data.order.external_id} -> ${event.data.order.status}` : '');
    });
  }).listen(8080, () => console.log('listening on :8080'));
}
