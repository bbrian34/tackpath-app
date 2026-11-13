// TP-LOADCHECK (migration 75): the same block is inlined in driver.html (web) and in the phone app's
// www/index.html (tackpath-driver), between the TP-LOADCHECK markers. It wraps the page's own functions:
//   processScan   while loading the van, every box is checked by TackPath first (tp_driver load_scan):
//                 on this route -> the page counts it as before; already loaded -> said so; another route's
//                 box or an unknown box -> "hand it back" (load_remove). No connection: the page counts it
//                 and the scan is sent when the connection is back.
//   confirmPickup the route leaves only when TackPath agrees (load_status): missing boxes and open load
//                 problems are listed; dispatch can resolve them.
// and adds: "Can't continue" (breakdown, accident...) while delivering, and "Receive boxes" when a
// dispatcher transfers another driver's boxes to this driver (scan each box; the rescue route then starts).
(function(){
  var W = window, D = document;
  if (W.__tpLoadCheck) return; W.__tpLoadCheck = true;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var job = function () { try { return (typeof currentJob !== 'undefined' && currentJob) || null; } catch (e) { return null; } };
  var call = function (action, args) { return W.tpDriver(action, args); };
  var loading = function () { return W._scanMode === 'package' || !!W._loadingPackages; };
  var lastEl = function () { return D.getElementById('loadPkgLastScan'); };
  var QKEY = 'tp_load_queue';
  var queue = function () { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch (e) { return []; } };
  var saveQueue = function (q) { try { localStorage.setItem(QKEY, JSON.stringify(q.slice(-500))); } catch (e) {} };
  // a TackPath without load checks (before migration 75) does not know these actions: the page works as before
  var unsupported = function (e) { return /unknown action|not allowed|does not exist|unsupported/i.test(String(e && e.message || e)); };
  var isNetwork = function (e) { var m = String(e && e.message || e); return !/TP_[A-Z]+/.test(m) && !unsupported(e); };
  var LC = W.TPLoadCheck = { busy: false, transfer: null };

  // ── load scans ──
  function flushQueue() {
    var q = queue(); if (!q.length) return Promise.resolve();
    var next = q[0];
    return call('load_scan', { id: next.id, code: next.code, client_id: next.cid }).then(function () { saveQueue(queue().slice(1)); return flushQueue(); }, function (e) {
      if (!isNetwork(e)) { saveQueue(queue().slice(1)); return flushQueue(); } });   // refused or unsupported: dropped
  }
  LC.flush = flushQueue;
  function showProblem(r, code) {
    var el = lastEl(); if (!el) return;
    var what = r.result === 'wrong_route' ? 'WRONG ROUTE' : 'NOT ON ANY ROUTE';
    var sub = r.result === 'wrong_route' ? 'This box belongs to ' + esc(r.belongs_to || 'another route') + '.' : 'TackPath does not know this box.';
    el.innerHTML = '<div style="color:#ff6b6b;font-weight:900;font-size:1.15rem;">&#10007; ' + what + '</div>'
      + '<div style="color:#fff;opacity:.9;font-size:.9rem;margin-top:4px;">' + esc(code) + ': ' + sub + ' Do not load it. Hand it back to the dock.</div>'
      + '<button type="button" id="tpHandBack" style="margin-top:12px;padding:12px 24px;border-radius:12px;background:#fff;color:#111;font-weight:900;border:none;">I handed it back</button>';
    var b = D.getElementById('tpHandBack');
    if (b) b.onclick = function () { b.disabled = true; call('load_remove', { id: job().id, code: code }).then(function () { el.innerHTML = '<div style="color:#4ade80;font-weight:800;">Handed back. Keep scanning.</div>'; }, function (e) { b.disabled = false; el.insertAdjacentHTML('beforeend', '<div style="color:#ff6b6b;">' + esc(String(e.message || e).replace(/^.*?TP_[A-Z]+:\s*/, '')) + '</div>'); }); };
    if (typeof W.speak === 'function') try { W.speak(r.result === 'wrong_route' ? 'Wrong route. Hand it back.' : 'Unknown package. Hand it back.'); } catch (e) {}
  }
  var original = W.processScan;
  if (typeof original === 'function') {
    W.processScan = function (barcode) {
      var j = job();
      if (!loading() || !j || !j.id || W._loadPaused) return original.apply(this, arguments);
      // the page counts and answers at once (sound, buzz, colour); TackPath records the same scan
      // and, for a box that is not this route's, says whose it is and asks for it back
      var out = original.apply(this, arguments), code = String(barcode || '').trim();
      var cid = 'ld-' + j.id + '-' + code + '-' + Date.now();
      LC.pending = call('load_scan', { id: j.id, code: code, client_id: cid }).then(function (r) {
        if (r && (r.result === 'wrong_route' || r.result === 'unknown')) showProblem(r, code);
        return r;
      }, function (e) {
        if (unsupported(e)) return null;
        if (isNetwork(e)) { var q = queue(); q.push({ id: j.id, code: code, cid: cid }); saveQueue(q); return null; }
        var el = lastEl(); if (el) el.innerHTML = '<div style="color:#ff6b6b;font-weight:800;">' + esc(String(e.message || e).replace(/^.*?TP_[A-Z]+:\s*/, '')) + '</div>';
        return null;
      });
      return out;
    };
  }

  // ── leaving: only when TackPath agrees ──
  function departPanel(st) {
    var host = D.getElementById('tpDepartPanel') || D.body.appendChild(Object.assign(D.createElement('div'), { id: 'tpDepartPanel' }));
    host.setAttribute('style', 'position:fixed;inset:0;z-index:9999;background:rgba(2,6,14,.92);color:#fff;display:flex;flex-direction:column;justify-content:center;padding:24px;font-family:system-ui,sans-serif;');
    var miss = (st.missing || []).map(function (m) { return '<li>' + esc(m.piece_id) + ' (stop ' + esc(m.stop_number) + ')' + (m.required > 1 ? ' ' + m.loaded_units + ' of ' + m.required : '') + '</li>'; }).join('');
    var probs = (st.discrepancies || []).map(function (d) { return '<li>' + esc(d.piece_id) + ': ' + (d.kind === 'load_wrong_route' ? 'belongs to ' + esc(d.belongs_to || 'another route') : 'unknown box') + '</li>'; }).join('');
    host.innerHTML = '<div style="font-weight:900;font-size:1.3rem;">You cannot leave yet</div>'
      + (miss ? '<div style="margin-top:12px;font-weight:800;">Not scanned into the van:</div><ul style="margin:6px 0 0 18px;">' + miss + '</ul>' : '')
      + (probs ? '<div style="margin-top:12px;font-weight:800;">Boxes to hand back:</div><ul style="margin:6px 0 0 18px;">' + probs + '</ul>' : '')
      + '<div style="margin-top:12px;opacity:.85;">Scan the missing boxes, hand back the wrong ones, or ask dispatch to decide.</div>'
      + '<button type="button" id="tpDepartScan" style="margin-top:18px;min-height:52px;border-radius:12px;border:0;background:#fff;color:#111;font-weight:900;">Scan more boxes</button>'
      + '<button type="button" id="tpDepartCheck" style="margin-top:10px;min-height:52px;border-radius:12px;border:1px solid #fff;background:transparent;color:#fff;font-weight:800;">Dispatch decided: check again</button>';
    D.getElementById('tpDepartScan').onclick = function () { host.remove(); var f = W.startPackageScan || W.startPackageLoadingVerification; if (typeof f === 'function') f(); };
    D.getElementById('tpDepartCheck').onclick = function () { host.remove(); W.confirmPickup(); };
  }
  var pickup = W.confirmPickup;
  if (typeof pickup === 'function') {
    W.confirmPickup = function () {
      var j = job(), self = this, args = arguments;
      if (!j || !j.id) return pickup.apply(self, args);
      return flushQueue().then(function () { return call('load_status', { id: j.id }); }).then(function (st) {
        if (st && st.scanning_started && !st.can_depart) { departPanel(st); return; }
        return pickup.apply(self, args);
      }, function (e) {
        if (isNetwork(e)) { if (typeof W.toast === 'function') W.toast('No connection: TackPath must confirm the load before you leave. Try again.', 'warn'); return; }
        return pickup.apply(self, args);       // an older TackPath without load checks
      });
    };
  }

  // ── can't continue ──
  function cantContinueButton() {
    var j = job(), show = !!(j && j.status === 'in_transit');
    var b = D.getElementById('tpCantContinue');
    if (!show) { if (b) b.remove(); return; }
    if (b) return;
    b = Object.assign(D.createElement('button'), { id: 'tpCantContinue', type: 'button', textContent: "Can't continue" });
    b.setAttribute('style', 'position:fixed;left:12px;bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:900;padding:10px 14px;border-radius:12px;border:0;background:#b91c1c;color:#fff;font:800 .85rem system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);');
    b.onclick = LC.openCantContinue;
    D.body.appendChild(b);
  }
  LC.openCantContinue = function () {
    var host = D.body.appendChild(Object.assign(D.createElement('div'), { id: 'tpCantPanel' }));
    host.setAttribute('style', 'position:fixed;inset:0;z-index:9999;background:rgba(2,6,14,.92);color:#fff;display:flex;flex-direction:column;justify-content:center;padding:24px;gap:10px;font-family:system-ui,sans-serif;');
    host.innerHTML = '<div style="font-weight:900;font-size:1.3rem;">What happened?</div>'
      + [['breakdown', 'Vehicle broke down'], ['accident', 'Accident'], ['illness', 'I am not well'], ['other', 'Something else']].map(function (r) {
        return '<button type="button" data-r="' + r[0] + '" style="min-height:52px;border-radius:12px;border:0;background:#fff;color:#111;font-weight:800;">' + r[1] + '</button>'; }).join('')
      + '<input id="tpCantNote" placeholder="Where are you? (optional)" style="min-height:48px;border-radius:12px;border:0;padding:0 12px;font-size:1rem;">'
      + '<button type="button" id="tpCantCancel" style="min-height:48px;border-radius:12px;border:1px solid #fff;background:transparent;color:#fff;font-weight:800;">Cancel</button>';
    host.querySelector('#tpCantCancel').onclick = function () { host.remove(); };
    host.querySelectorAll('[data-r]').forEach(function (btn) {
      btn.onclick = function () {
        var note = D.getElementById('tpCantNote').value;
        call('cant_continue', { id: job().id, reason: btn.getAttribute('data-r'), note: note }).then(function () {
          host.innerHTML = '<div style="font-weight:900;font-size:1.3rem;">Dispatch has been told</div><div style="margin-top:10px;opacity:.9;">Stay with the vehicle and keep the boxes safe. Another driver will come and scan them over to their van.</div>'
            + '<button type="button" style="margin-top:18px;min-height:52px;border-radius:12px;border:0;background:#fff;color:#111;font-weight:900;">OK</button>';
          host.querySelector('button').onclick = function () { host.remove(); };
        }, function (e) { if (typeof W.toast === 'function') W.toast('Could not reach dispatch: ' + String(e.message || e).replace(/^.*?TP_[A-Z]+:\s*/, ''), 'warn'); });
      };
    });
  };

  // ── receiving another driver's boxes ──
  function transferBanner(list) {
    var b = D.getElementById('tpTransferBanner');
    var t = (list || [])[0];
    if (!t || LC.transfer) { if (b && !LC.transfer) b.remove(); return; }
    if (!b) { b = D.body.appendChild(Object.assign(D.createElement('button'), { id: 'tpTransferBanner', type: 'button' })); }
    b.setAttribute('style', 'position:fixed;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top,0px));z-index:950;min-height:56px;border-radius:14px;border:0;background:#f59e0b;color:#111;font:900 1rem system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.35);');
    b.textContent = 'Receive ' + (t.pieces.length - t.scanned.length) + ' boxes from ' + (t.from_driver || 'another driver');
    b.onclick = function () { LC.startTransfer(t); };
  }
  LC.startTransfer = function (t) {
    LC.transfer = { id: t.id, pieces: t.pieces.slice(), scanned: t.scanned.slice(), from: t.from_driver, to_job_id: t.to_job_id };
    var bn = D.getElementById('tpTransferBanner'); if (bn) bn.remove();
    var host = D.body.appendChild(Object.assign(D.createElement('div'), { id: 'tpTransferPanel' }));
    host.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:960;background:#0f172a;color:#fff;padding:14px 16px calc(14px + env(safe-area-inset-bottom,0px));font-family:system-ui,sans-serif;border-top-left-radius:16px;border-top-right-radius:16px;');
    LC.renderTransfer();
    if (typeof W.showScreen === 'function') W.showScreen('scScan');
    if (typeof W.startCamera === 'function') W.startCamera();
  };
  LC.renderTransfer = function (msg) {
    var t = LC.transfer, host = D.getElementById('tpTransferPanel'); if (!t || !host) return;
    var left = t.pieces.filter(function (p) { return t.scanned.indexOf(p) < 0; });
    host.innerHTML = '<div style="font-weight:900;font-size:1.05rem;">Receiving from ' + esc(t.from || 'another driver') + ': ' + t.scanned.length + ' of ' + t.pieces.length + '</div>'
      + (msg ? '<div style="margin-top:6px;font-weight:800;">' + msg + '</div>' : '')
      + '<div style="margin-top:6px;font:600 .75rem ui-monospace,monospace;opacity:.85;max-height:64px;overflow:auto;">' + left.map(esc).join(' &middot; ') + '</div>'
      + '<input id="tpTransferInput" placeholder="Scan or type a box" style="margin-top:8px;width:100%;min-height:44px;border-radius:10px;border:0;padding:0 10px;font-size:1rem;box-sizing:border-box;">';
    var inp = D.getElementById('tpTransferInput');
    inp.onkeydown = function (e) { if (e.key === 'Enter') { var v = inp.value; inp.value = ''; LC.transferScan(v); } };
  };
  LC.transferScan = function (code) {
    var t = LC.transfer; if (!t || !String(code || '').trim()) return Promise.resolve();
    return call('transfer_scan', { transfer_id: t.id, code: String(code).trim() }).then(function (r) {
      if (r && (r.result === 'received' || r.result === 'already_received')) {
        if (t.scanned.indexOf(r.piece_id) < 0) t.scanned.push(r.piece_id);
        if (r.complete) return LC.finishTransfer();
        LC.renderTransfer('&#10003; ' + esc(r.piece_id) + (r.result === 'already_received' ? ' already received' : ' is now in your van'));
      } else LC.renderTransfer('<span style="color:#ff6b6b;">&#10007; ' + esc(code) + ' is not one of these boxes</span>');
    }, function (e) { LC.renderTransfer('<span style="color:#ff6b6b;">' + esc(String(e.message || e).replace(/^.*?TP_[A-Z]+:\s*/, '')) + '</span>'); });
  };
  LC.finishTransfer = function () {
    var t = LC.transfer;
    if (typeof W.stopCamera === 'function') W.stopCamera();
    return call('update_job', { id: t.to_job_id, patch: { status: 'in_transit', picked_up_at: new Date().toISOString() } }).then(function () {
      var host = D.getElementById('tpTransferPanel');
      if (host) host.innerHTML = '<div style="font-weight:900;font-size:1.1rem;">All ' + t.pieces.length + ' boxes are in your van.</div><div style="margin-top:6px;">The route is starting.</div>';
      LC.transfer = null;
      setTimeout(function () { try { W.location.reload(); } catch (e) {} }, 1200);
    });
  };
  // the camera hands transfer scans here while receiving
  var proc2 = W.processScan;
  W.processScan = function (barcode) { if (LC.transfer) return LC.transferScan(barcode); return proc2.apply(this, arguments); };

  // ── a light poll: queued scans, can't-continue button, transfers waiting ──
  LC.tick = function () {
    if (typeof W.tpToken === 'function' && !W.tpToken()) return Promise.resolve();
    cantContinueButton();
    flushQueue();
    return call('transfers', {}).then(function (l) { transferBanner(Array.isArray(l) ? l : []); }, function () {});
  };
  setInterval(function () { LC.tick(); }, 20000);
  setTimeout(function () { LC.tick(); }, 2500);
})();
