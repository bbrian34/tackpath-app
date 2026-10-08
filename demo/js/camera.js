/* TackPath demo — what the driver's phone camera "sees".
   The driver app's own scanner (getUserMedia + BarcodeDetector) runs
   unchanged; the demo paints the camera picture here: a shipping label with
   a real Code 128 barcode, a bin's QR tag, or a doorstep for the delivery
   photo. Drawing only; no network. */
(function (root) {
  'use strict';
  const D = root.DEMO_DATA;
  const cache = new Map();

  function barcode(code) {
    const k = 'bc:' + code;
    if (cache.has(k)) return cache.get(k);
    const c = document.createElement('canvas');
    try { root.JsBarcode(c, code, { format: 'CODE128', displayValue: false, margin: 0, height: 90, width: 3 }); } catch (e) {}
    cache.set(k, c); return c;
  }
  function qr(text) {
    const k = 'qr:' + text;
    if (cache.has(k)) return cache.get(k);
    const host = document.createElement('div');
    let c = null;
    try { new root.QRCode(host, { text, width: 220, height: 220, correctLevel: root.QRCode.CorrectLevel.M }); c = host.querySelector('canvas'); } catch (e) {}
    cache.set(k, c); return c;
  }
  function stopFor(tn) {
    for (let i = 0; i < D.STOPS.length; i++) {
      const s = D.STOPS[i];
      for (let j = 0; j < s.lines.length; j++) if (s.lines[j][0] === tn) return s;
    }
    return null;
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // Background: inside of a van / warehouse floor, slightly moving like a hand-held phone.
  function backdrop(ctx, W, H, t, tone) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, tone === 'door' ? '#6b5a48' : '#3a3f47'); g.addColorStop(1, tone === 'door' ? '#2c241c' : '#16191e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function drawLabel(ctx, W, H, code, t) {
    const s = stopFor(code) || {};
    const wob = Math.sin(t / 700) * 0.02, dx = Math.sin(t / 900) * 6, dy = Math.cos(t / 1100) * 5;
    // cardboard box
    ctx.save(); ctx.translate(W / 2 + dx, H / 2 + dy); ctx.rotate(-0.04 + wob);
    ctx.fillStyle = '#b98a55'; rr(ctx, -W * 0.46, -H * 0.42, W * 0.92, H * 0.84, 10); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.08)'; ctx.fillRect(-W * 0.46, -12, W * 0.92, 24);
    // label
    const lw = W * 0.74, lh = H * 0.66;
    ctx.fillStyle = '#fbfbf7'; rr(ctx, -lw / 2, -lh / 2, lw, lh, 6); ctx.fill();
    ctx.fillStyle = '#111'; ctx.font = '800 26px "DM Sans", sans-serif'; ctx.textBaseline = 'top';
    ctx.fillText('PEACHLINE COURIER', -lw / 2 + 18, -lh / 2 + 14);
    ctx.font = '600 15px "DM Mono", monospace'; ctx.fillText('SAME DAY · ATL', lw / 2 - 150, -lh / 2 + 22);
    ctx.fillRect(-lw / 2 + 12, -lh / 2 + 50, lw - 24, 3);
    ctx.font = '700 22px "DM Sans", sans-serif'; ctx.fillText('SHIP TO', -lw / 2 + 18, -lh / 2 + 62);
    ctx.font = '800 30px "DM Sans", sans-serif'; ctx.fillText(String(s.recipient || '').slice(0, 26), -lw / 2 + 18, -lh / 2 + 88);
    ctx.font = '500 21px "DM Sans", sans-serif';
    const addr = String(s.address || '').split(', ');
    ctx.fillText(addr[0] || '', -lw / 2 + 18, -lh / 2 + 126);
    ctx.fillText(addr.slice(1).join(', '), -lw / 2 + 18, -lh / 2 + 152);
    const bc = barcode(code);
    if (bc && bc.width) ctx.drawImage(bc, -lw / 2 + 24, lh / 2 - 150, lw - 48, 96);
    ctx.font = '700 24px "DM Mono", monospace'; ctx.textAlign = 'center';
    ctx.fillText(code, 0, lh / 2 - 46);
    ctx.textAlign = 'left';
    ctx.restore();
  }
  function drawBin(ctx, W, H, code, t) {
    const label = String(code).replace(/^BIN[:\s-]*/i, '');
    const dx = Math.sin(t / 900) * 5, dy = Math.cos(t / 1100) * 4;
    ctx.save(); ctx.translate(W / 2 + dx, H / 2 + dy); ctx.rotate(0.02 + Math.sin(t / 800) * 0.015);
    ctx.fillStyle = '#1f5fbf'; rr(ctx, -W * 0.47, -H * 0.4, W * 0.94, H * 0.8, 18); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.08)'; for (let i = 0; i < 5; i++) ctx.fillRect(-W * 0.47, -H * 0.4 + i * H * 0.17, W * 0.94, 4);
    ctx.fillStyle = '#fff'; rr(ctx, -150, -175, 300, 350, 10); ctx.fill();
    const q = qr(code);
    if (q) ctx.drawImage(q, -110, -150, 220, 220);
    ctx.fillStyle = '#111'; ctx.font = '900 44px "DM Sans", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('BIN ' + label, 0, 92);
    ctx.textAlign = 'left'; ctx.restore();
  }
  function drawDoor(ctx, W, H, t, sc) {
    const dx = Math.sin(t / 900) * 4;
    ctx.save(); ctx.translate(dx, 0);
    ctx.fillStyle = '#8f8676'; ctx.fillRect(0, 0, W, H);                      // wall
    ctx.fillStyle = '#2f4a3a'; ctx.fillRect(W * 0.28, H * 0.06, W * 0.44, H * 0.7); // door
    ctx.fillStyle = '#d9c58a'; ctx.beginPath(); ctx.arc(W * 0.66, H * 0.43, 9, 0, 7); ctx.fill();
    ctx.fillStyle = '#5b5348'; ctx.fillRect(0, H * 0.76, W, H * 0.24);          // step
    ctx.fillStyle = '#6d4c30'; rr(ctx, W * 0.32, H * 0.78, W * 0.36, H * 0.07, 6); ctx.fill(); // mat
    ctx.fillStyle = '#b98a55'; ctx.fillRect(W * 0.40, H * 0.62, W * 0.2, H * 0.17); // box
    ctx.fillStyle = '#fbfbf7'; ctx.fillRect(W * 0.43, H * 0.66, W * 0.1, H * 0.06);
    ctx.fillStyle = '#fff'; ctx.font = '800 26px "DM Sans", sans-serif'; ctx.textBaseline = 'top';
    if (sc && sc.unit) ctx.fillText(sc.unit, W * 0.45, H * 0.1);
    ctx.restore();
  }

  function draw(ctx, W, H, scene, t) {
    scene = scene || { kind: 'idle' };
    backdrop(ctx, W, H, t, scene.kind);
    if (scene.kind === 'label') drawLabel(ctx, W, H, scene.code, t);
    else if (scene.kind === 'bin') drawBin(ctx, W, H, scene.code, t);
    else if (scene.kind === 'door') drawDoor(ctx, W, H, t, scene);
    // a touch of sensor noise so it reads as a camera
    ctx.fillStyle = 'rgba(255,255,255,.025)';
    for (let i = 0; i < 40; i++) ctx.fillRect((i * 97 + t * 0.37) % W, (i * 53 + t * 0.21) % H, 2, 2);
  }

  root.DEMO_CAMERA = { draw, barcode, qr, stopFor };
})(window);
