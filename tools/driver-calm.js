// TP-CALM (2026-11): less clutter at a delivery stop. The same block is inlined in driver.html (web)
// and in the phone app's www/index.html (tackpath-driver), between the TP-CALM markers, after
// TP-LOADCHECK. Like the delivery apps drivers already know, every stop screen shows the next step
// as the main button, and everything off the normal path sits behind ONE "Problem" button:
//   stop screen    Navigate / Deliver, plus Problem. (Message, Ruby and Can't continue moved into Problem.)
//   scan screen    the camera and the typed number, plus Problem. (Label damaged, Tell dispatch,
//                  Can't continue moved into Problem.)
//   proof          Handed to customer / Front door, the photo, Confirm, plus Problem. Mailroom, Back door,
//                  signature, recipient name and notes are one tap away under "More options".
// Nothing is removed: the original buttons stay in the page (hidden) and the Problem menu presses them,
// so every action works exactly as before. Only the newest notice shows at a time.
(function () {
  var W = window, D = document;
  if (W.__tpCalm) return; W.__tpCalm = true;
  var $ = function (id) { return D.getElementById(id); };
  var on = function (id) { var s = $(id); return !!(s && s.classList.contains('on')); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var dx = function () { return W.dx || {}; };

  var css = D.createElement('style'); css.id = 'tpCalmCss';
  css.textContent = [
    // one notice at a time (the newest), never a stack over the stop's name
    '#tw .toast:not(:last-child){display:none!important;}',
    // moved into the Problem menu
    '#tpCantContinue{display:none!important;}',
    '#scSurgeDelivery .ruby-btn{display:none!important;}',
    '#scSurgeDelivery .dx-actions [onclick^="dx.messageDispatch"]{display:none!important;}',
    '#dlvScanOverlay [onclick^="dsLabelDamaged"],#dlvScanOverlay .dx-help{display:none!important;}',
    // proof of delivery: the two usual choices up front, the rest under More options
    'body:not(.tp-calm-more) #scPOD [onclick="dx.choose(\'mailroom\')"],body:not(.tp-calm-more) #scPOD [onclick="dx.choose(\'back_door\')"],'
      + 'body:not(.tp-calm-more) #scPOD .pod-tab-row,body:not(.tp-calm-more) #scPOD .tp-calm-extra{display:none!important;}',
    '#scPOD .dx-link-bad{display:none!important;}',
    // the Problem button on the scan and proof screens
    '.tp-calm-prob{position:fixed;top:calc(10px + env(safe-area-inset-top,0px));right:10px;z-index:950;min-height:44px;padding:0 16px;border-radius:12px;'
      + 'border:1.5px solid rgba(255,120,120,.6);background:rgba(185,28,28,.18);color:#fff;font:800 .95rem/1 var(--sans,system-ui);cursor:pointer;}',
    '#tpCalmProbScan{position:static;display:block;margin:12px auto 0;}',
    '.tp-calm-more-btn{display:block;width:100%;margin:2px 0 12px;padding:10px;border:0;background:none;color:#8ab4cc;font:700 .95rem/1.2 var(--sans,system-ui);text-decoration:underline;cursor:pointer;}'
  ].join('\n');
  D.head.appendChild(css);

  // ── the Problem menu ──
  function closeMenu() { var s = $('dxSheet'); if (s) s.remove(); }
  function menu(items) {
    closeMenu();
    var s = D.createElement('div'); s.className = 'dx-scrim'; s.id = 'dxSheet';
    s.addEventListener('click', function (e) { if (e.target === s) closeMenu(); });
    var box = D.createElement('div'); box.className = 'dx-sheet'; box.setAttribute('role', 'dialog'); box.id = 'tpCalmMenu';
    box.innerHTML = '<h3>What is the problem?</h3>';
    items.concat([{ label: 'Close', cls: 'dx-btn ghost wide', fn: closeMenu }]).forEach(function (it) {
      var b = D.createElement('button'); b.type = 'button'; b.className = it.cls || 'dx-opt';
      if (it.id) b.setAttribute('data-calm', it.id);
      b.innerHTML = esc(it.label) + (it.hint ? '<small>' + esc(it.hint) + '</small>' : '');
      b.onclick = function () { if (it.cls) return it.fn(); closeMenu(); it.fn(); };
      box.appendChild(b);
    });
    s.appendChild(box); D.body.appendChild(s); return box;
  }
  var press = function (el) { return function () { if (el) el.click(); }; };
  function openProblems() {
    var items = [];
    var scanning = on('scScan'), proof = on('scPOD');
    var labels = Array.prototype.slice.call(D.querySelectorAll('#dlvScanOverlay [onclick^="dsLabelDamaged"]'));
    var help = D.querySelector('#dlvScanOverlay .dx-help');
    var boxOf = function (b) { var m = /dsLabelDamaged\((.*)\)/.exec(b.getAttribute('onclick') || ''); try { return JSON.parse(m[1]); } catch (e) { return ''; } };
    if (typeof dx().problem === 'function')
      items.push({ id: 'cant_deliver', label: "Can't deliver this stop", hint: 'Not home, no access, closed, refused, damaged…', fn: function () { dx().problem(); } });
    if (scanning && labels.length) items.push({ id: 'label', label: "Label damaged or won't scan", hint: 'Count a box whose label will not scan',
      fn: labels.length === 1 ? press(labels[0]) : function () {
        menu(labels.map(function (b) { return { id: 'label_box', label: 'Box ' + boxOf(b), fn: press(b) }; }));
        var t = $('tpCalmMenu'); if (t) t.querySelector('h3').textContent = 'Which box?';
      } });
    if (typeof dx().messageDispatch === 'function') items.push({ id: 'message', label: 'Message dispatch', fn: scanning && help ? press(help) : function () { dx().messageDispatch(); } });
    if (typeof W.activateRuby === 'function' && !scanning) items.push({ id: 'ruby', label: 'Ruby (voice help)', fn: function () { W.activateRuby(); } });
    var cc = $('tpCantContinue');
    if (cc) items.push({ id: 'cant_continue', label: "Can't continue the route", hint: 'Breakdown, accident, not well: dispatch sends another driver', fn: press(cc) });
    return menu(items);
  }
  W.TPCalm = { openProblems: openProblems, closeMenu: closeMenu };

  // ── wiring, kept up to date as the page redraws its screens ──
  function probButton(id, show) {
    var b = $(id);
    if (!show) { if (b) b.remove(); return; }
    if (b) return;
    b = D.createElement('button'); b.type = 'button'; b.id = id; b.className = 'tp-calm-prob'; b.textContent = 'Problem';
    b.onclick = openProblems; D.body.appendChild(b);
  }
  function tidy() {
    // the stop screen's own Problem button opens the one menu
    var pb = $('dxProblemBtn');
    if (pb && !pb.__calm) { pb.__calm = true; pb.onclick = openProblems; }
    var dlv = $('dlvScanOverlay'), help = dlv && dlv.querySelector('.dx-help');
    if (help && !$('tpCalmProbScan')) {
      var sb = D.createElement('button'); sb.type = 'button'; sb.id = 'tpCalmProbScan'; sb.className = 'tp-calm-prob'; sb.textContent = 'Problem';
      sb.onclick = openProblems; help.parentNode.insertBefore(sb, help.nextSibling);
    }
    probButton('tpCalmProbPod', on('scPOD'));
    // proof of delivery: recipient name and notes go under More options
    var pod = $('scPOD');
    if (pod) {
      ['podRecipient', 'podNotes'].forEach(function (id) { var el = $(id); var sec = el && el.closest('.pod-sec'); if (sec) sec.classList.add('tp-calm-extra'); });
      var grid = pod.querySelector('.dx-choices');
      var more = $('tpCalmMore');
      if (grid && !more) {
        more = D.createElement('button'); more.type = 'button'; more.id = 'tpCalmMore'; more.className = 'tp-calm-more-btn'; more.textContent = 'More options';
        more.onclick = function () { var o = D.body.classList.toggle('tp-calm-more'); more.textContent = o ? 'Fewer options' : 'More options'; };
      }
      if (grid && more && grid.nextSibling !== more) grid.parentNode.insertBefore(more, grid.nextSibling);
    }
    if (!on('scPOD') && D.body.classList.contains('tp-calm-more')) { D.body.classList.remove('tp-calm-more'); var m = $('tpCalmMore'); if (m) m.textContent = 'More options'; }
  }
  var pending = false;
  new MutationObserver(function () { if (pending) return; pending = true; setTimeout(function () { pending = false; tidy(); }, 0); })
    .observe(D.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  tidy();
})();
