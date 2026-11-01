/* Keel test lab: runs first inside each Keel screen (an iframe named after its
   station). It gives the station its own sign-in storage, sends Keel's API
   calls to the Keel server running in the lab page, keeps navigation inside
   the app's folder, and lets the lab "scan" a barcode into the screen the way
   a handheld's scanner types it. Keel's own code is unchanged. */
(function () {
  'use strict';
  var LAB = window.parent && window.parent.KEEL_LAB;
  if (!LAB) return;
  var W = window, ST = W.name || 'keel';
  var BASE = '/keeltest/app';

  function makeStorage(obj) {
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null; },
      setItem: function (k, v) { obj[k] = String(v); },
      removeItem: function (k) { delete obj[k]; },
      clear: function () { Object.keys(obj).forEach(function (k) { delete obj[k]; }); },
      key: function (i) { var ks = Object.keys(obj); return i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(obj).length; }
    };
  }
  Object.defineProperty(W, 'localStorage', { configurable: true, value: makeStorage(LAB.storage(ST)) });
  Object.defineProperty(W, 'sessionStorage', { configurable: true, value: makeStorage({}) });

  // Keel's API lives in the lab page
  var realFetch = W.fetch.bind(W);
  W.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin === location.origin && /^\/(api|hooks)\//.test(url.pathname)) return LAB.request(url.pathname + url.search, init || {}, ST);
    return realFetch(input, init);
  };

  // start on the station's own screen
  var start = LAB.startPath(ST);
  if (start && (location.pathname === BASE + '/' || location.pathname === BASE)) history.replaceState(null, '', BASE + start);

  // plain links like href="/orders" stay inside the app
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) !== '/' || href.indexOf(BASE) === 0 || /^\/(api|hooks)\//.test(href)) return;
    e.preventDefault();
    history.pushState(null, '', BASE + href);
    W.dispatchEvent(new PopStateEvent('popstate'));
  }, true);

  // a scan: the code is typed into the scan field, then Enter, as DataWedge does
  W.__KEEL_SCAN__ = function (code) {
    var el = document.querySelector('input[data-scan]');
    if (!el) return false;
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, code);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return true;
  };
  W.__KEEL_PATH__ = function () { return location.pathname.replace(BASE, '') || '/'; };
})();
