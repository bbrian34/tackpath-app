// Browser side of the video: the real pages in Chromium, every request answered
// locally (backend.mjs for the gateway, stand-ins for maps / proof of delivery).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { tile } from './tiles.mjs';

const require = createRequire(import.meta.url);
export const { launch } = require('../../tests/browser.js');
export const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
// The phone app's page: tackpath-driver/www/index.html (the driver app). DRIVER_PAGE overrides.
export const DRIVER_PAGE = process.env.DRIVER_PAGE || path.join(APP, '..', 'tackpath-driver', 'www', 'index.html');

// Demo customers: fictional names at fictional numbers on real-sounding street names; coordinates are illustrative.
export const GEO = {};
// Pause on map lookups (ms) so a recording can see SmartSort at work; 0 = answer at once.
export const PACE = { geo: 0 };
const pause = () => new Promise((r) => setTimeout(r, PACE.geo));
const json = (status, data) => ({ status, contentType: 'application/json', body: JSON.stringify(data) });
const haversine = (a, b) => { const R = 6371000, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLn = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLn / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==', 'base64');

export async function wire(ctx, be, log = () => {}) {
  await ctx.route(/^https?:\/\//, async (r) => {
    const url = r.request().url();
    let body = {};
    try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
    const m = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/);
    if (m) {
      try { const res = await be.call(m[1], body); return r.fulfill(json(200, res === undefined ? null : res)); }
      catch (e) { log('rpc ' + m[1] + ' ' + (body.p_action || '') + ': ' + e.message); return r.fulfill(json(400, { message: e.message })); }
    }
    let t = url.match(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (t) return r.fulfill({ status: 200, contentType: 'image/png', body: tile(+t[1], +t[2], +t[3]) });
    if (/maps\/api\/geocode/.test(url)) {
      await pause();
      const a = decodeURIComponent((url.match(/address=([^&]+)/) || [])[1] || '').replace(/\+/g, ' ');
      const g = GEO[a.trim()];
      return r.fulfill(json(200, g ? { status: 'OK', results: [{ geometry: { location: g } }] } : { status: 'ZERO_RESULTS', results: [] }));
    }
    if (/functions\/v1\/smooth-api/.test(url)) {
      await pause();
      if (body.action === 'matrix') {
        const out = []; body.params.origins.forEach((o, i) => body.params.destinations.forEach((d, j) => {
          const meters = Math.round(haversine(o, d) * 1.3); out.push({ originIndex: i, destinationIndex: j, condition: 'ROUTE_EXISTS', distanceMeters: meters, duration: Math.round(meters / 11) + 's' }); }));
        return r.fulfill(json(200, out));
      }
      if (body.action === 'geocode') { const g = GEO[(body.params && body.params.address || '').trim()];
        return r.fulfill(json(200, g ? { status: 'OK', results: [{ geometry: { location: g } }] } : { status: 'ZERO_RESULTS', results: [] })); }
      return r.fulfill(json(200, {}));
    }
    if (/functions\/v1\/pod/.test(url)) return r.fulfill(json(200, { path: (body.job_id || 'job') + '/pod.jpg' }));
    if (/functions\/v1\//.test(url)) return r.fulfill(json(200, { ok: true }));
    if (/\.(png|jpe?g|gif|webp)(\?|$)/.test(url)) return r.fulfill({ status: 200, contentType: 'image/png', body: PNG1 });
    if (/maps\.googleapis\.com\/maps\/api\/js|google\.com\/maps|fonts\.g/.test(url)) return r.abort();
    return r.fulfill(json(200, []));
  });
}
