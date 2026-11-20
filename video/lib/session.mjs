// Open the three real pages against the shared local backend: the dispatcher
// signed in to the demo company, PathIQ at its badge screen, the phone at sign-in.
import { launch, wire, APP, DRIVER_PAGE } from './apps.mjs';
import { ORG, DRIVER, WORKER } from './backend.mjs';

// The phone app's native plugins, as the driver tests stand them in (nothing native runs here).
const CAPACITOR = () => {
  window.__nat = [];
  window.Capacitor = { isNativePlatform: () => true, platform: 'android', Plugins: {
    ArrivalPlugin: { start: async (o) => { window.__nat.push(['arrival.start', o]); }, stop: async () => { window.__nat.push(['arrival.stop']); },
      overlayStatus: async () => ({ granted: true }), openOverlaySettings: async () => {} },
    AppLauncher: { openUrl: async (o) => { window.__nat.push(['maps', o.url]); return { completed: true }; } },
    TextToSpeech: { speak: async () => {} },
    LocalNotifications: { requestPermissions: async () => ({ display: 'granted' }), createChannel: async () => {}, registerActionTypes: async () => {},
      addListener: () => ({ remove() {} }), schedule: async () => {}, cancel: async () => {} } } };
};

// Recording only (never in the app files):
//  - long dashes in the pages' own text are shown as plain hyphens;
//  - hidden: the voice-assistant buttons, the Google map embed in the route
//    drawer (no network here), the map credit (the tiles are drawn locally,
//    see tiles.mjs) and SmartSort's internal self-check list.
const RECORDING = (css) => {
  const fix = (n) => { if (n.nodeType === 3) { if (/[\u2014\u2013]/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/\s*\u2014\s*/g, ' - ').replace(/\u2013/g, '-'); }
    else if (n.nodeType === 1 && !/^(SCRIPT|STYLE)$/.test(n.tagName)) { n.childNodes.forEach(fix); for (const a of ['placeholder', 'title']) { const v = n.getAttribute && n.getAttribute(a); if (v && /\u2014/.test(v)) n.setAttribute(a, v.replace(/\s*\u2014\s*/g, ' - ')); } } };
  const go = () => { const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    fix(document.body); new MutationObserver((ms) => ms.forEach((m) => { if (m.type === 'characterData') fix(m.target); else m.addedNodes.forEach(fix); }))
      .observe(document.body, { childList: true, subtree: true, characterData: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
};
const HIDE = '#ssSelfCheckPanel,.ruby-btn,#rubyJobBtn,#commsRubyBtn,#drMap,.cr-lbl,.leaflet-control-attribution{display:none!important}';

export async function openApps(be, { log = console.log, camera } = {}) {
  const browser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    ...(camera ? ['--use-file-for-fake-video-capture=' + camera] : []), '--force-color-profile=srgb', '--font-render-hinting=none']);
  const org = await be.call('tp_org_sign_in', { p_slug: ORG.slug, p_code: ORG.code });
  const mk = async (opts, init, arg, file) => {
    const ctx = await browser.newContext(Object.assign({ deviceScaleFactor: 2, timezoneId: 'America/New_York', locale: 'en-US' }, opts));
    await wire(ctx, be, log);
    await ctx.addInitScript(RECORDING, HIDE);
    if (init) await ctx.addInitScript(init, arg);
    const p = await ctx.newPage();
    ctx.on('page', (q) => { if (q !== p) q.close().catch(() => {}); }); // the labels window
    p.on('pageerror', (e) => { if (!/ServiceWorker/.test(e.message)) log('pageerror ' + file.split('/').pop() + ': ' + e.message); });
    p.on('dialog', (d) => d.accept());
    await p.goto('file://' + file);
    return p;
  };
  const orgStore = JSON.stringify({ id: org.org.id, slug: org.org.slug, name: org.org.name, token: org.token });
  const dispatch = await mk({ viewport: { width: 1280, height: 720 } },
    (s) => { try { localStorage.setItem('tp_dispatch_org', s); localStorage.setItem('tp_dispatch_theme', 'light'); sessionStorage.setItem('tackpath_splash_shown', '1'); } catch (e) {} }, orgStore, APP + '/dispatcher.html');
  // PathIQ on the TC56: scans arrive the way DataWedge delivers them, through
  // the ZebraScanner plugin; window.__scan(value) is one trigger pull.
  const pathiq = await mk({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true }, (worker) => {
    const ls = []; window.__scan = (value) => ls.forEach((f) => f({ value }));
    window.Capacitor = { isNativePlatform: () => true, platform: 'android', Plugins: { ZebraScanner: { addListener: (ev, f) => { ls.push(f); return { remove() {} }; } } } };
    try { localStorage.setItem('tp_worker', worker); } catch (e) {}
  }, WORKER, APP + '/stow.html');
  // The driver signs in on the phone's own sign-in screen (see signInPhone), so
  // the app starts the way it does after a fresh sign-in.
  const phone = await mk({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true },
    (cap) => { eval('(' + cap + ')')(); try { localStorage.setItem('tp_dx_perm_intro', '1'); } catch (e) {} }, CAPACITOR.toString(), DRIVER_PAGE);
  return { browser, dispatch, pathiq, phone, org };
}

// Phone number, then the 6-digit code (the code the text message would carry,
// read from the stand-in backend).
export async function signInPhone(phone, be) {
  await phone.fill('#loginPhone', DRIVER.phone);
  await phone.locator('button[onclick*="requestCode"]').first().click();
  await phone.waitForSelector('#loginCode', { state: 'visible' });
  await phone.fill('#loginCode', await be.driverCode());
  // six digits sign in on their own; the button is only needed if they did not
  await phone.waitForTimeout(800);
  if (await phone.locator('#loginVerifyBtn').isVisible()) await phone.click('#loginVerifyBtn');
  await phone.waitForFunction(() => typeof driver !== 'undefined' && driver && driver.token, null, { timeout: 10000 });
}
