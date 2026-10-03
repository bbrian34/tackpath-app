const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Loads a live TackPath HTML file and boots it in jsdom with mockable
// fetch/localStorage/Capacitor, so real app code runs against fake data
// instead of the live Supabase backend.
function loadApp(htmlFilename, { url, fetchHandler, initialStorage = {} } = {}) {
  const htmlPath = path.join(__dirname, '..', htmlFilename);
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const storage = { ...initialStorage };
  const calls = { fetch: [] };

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    resources: undefined,
    url: url || 'https://tackpath.com/' + htmlFilename,
    pretendToBeVisual: true,
    beforeParse(window) {
      delete window.speechSynthesis;
      window.Element.prototype.scrollIntoView = () => {};
      window.fetch = async (reqUrl, opts) => {
        calls.fetch.push({ url: reqUrl, opts });
        if (fetchHandler) {
          const result = await fetchHandler(reqUrl, opts, storage);
          if (result !== undefined) return result;
        }
        return { ok: true, json: async () => ([]) };
      };
      window.Capacitor = {
        Plugins: {
          AppLauncher: { openUrl: async () => ({ completed: true }) },
          LocalNotifications: {
            requestPermissions: async () => ({ display: 'granted' }),
            createChannel: async () => {},
            registerActionTypes: async () => {},
            addListener: () => {},
            schedule: async () => {},
            cancel: async () => {},
          },
        },
      };
      Object.defineProperty(window, 'localStorage', {
        value: {
          getItem: (k) => (k in storage ? storage[k] : null),
          setItem: (k, v) => { storage[k] = v; },
          removeItem: (k) => { delete storage[k]; },
        },
      });
    },
  });

  dom.window.onerror = (msg) => {
    throw new Error('Runtime error in ' + htmlFilename + ': ' + msg);
  };

  return { dom, storage, calls, cleanup: () => dom.window.close() };
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Decodes a call to a secured RPC (security hardening 2026-10):
// POST /rest/v1/rpc/<fn> {p_token, p_action, p_args, ...} -> {fn, action, args, token, body}.
// Returns null for anything else.
function rpcCall(url, opts) {
  const m = String(url).match(/\/rest\/v1\/rpc\/([a-z_]+)/);
  if (!m) return null;
  let body = {};
  try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { body = {}; }
  return { fn: m[1], action: body.p_action, args: body.p_args || {}, token: body.p_token, body };
}
const jsonResp = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => data, text: async () => JSON.stringify(data),
});

// For tests written against the old direct-table REST calls: answers the
// secured company RPCs (tp_org_sign_in, tp_org_lookup, tp_org) by asking the
// test's REST-style handler the equivalent table question. The tests keep
// checking page behaviour; the access rules themselves are tested against a
// real database in tests/security.
function legacyRest(handler) {
  const base = 'https://hofijsiphyjpdvujjzfi.supabase.co/rest/v1/';
  const ask = async (path, method, body, storage) => {
    const r = await handler(base + path, method ? { method, body: body ? JSON.stringify(body) : undefined } : undefined, storage);
    if (!r) return [];
    try { return await r.json(); } catch (e) { return []; }
  };
  return async (url, opts, storage) => {
    const c = rpcCall(url, opts);
    if (!c) return handler(url, opts, storage);
    const a = c.args;
    let out;
    if (c.fn === 'tp_org_lookup' || c.fn === 'tp_org_sign_in') {
      const rows = await ask('organizations?slug=eq.' + encodeURIComponent(c.body.p_slug || ''), null, null, storage);
      const org = Array.isArray(rows) && rows[0] ? { id: rows[0].id, slug: rows[0].slug, name: rows[0].name } : null;
      out = c.fn === 'tp_org_lookup' ? org
        : (org ? { ok: true, token: 'test-session', org } : { ok: false, error: 'TP_DENIED' });
    } else if (c.fn === 'tp_sign_out') {
      out = { ok: true };
    } else if (c.fn === 'tp_org') {
      switch (c.action) {
        case 'jobs': out = await ask('jobs?select=*' + (a.ids ? '&id=in.(' + a.ids.join(',') + ')' : ''), null, null, storage); break;
        case 'job': out = ((await ask('jobs?id=eq.' + a.id, null, null, storage)) || [])[0] || null; break;
        case 'update_job': out = await ask('jobs?id=eq.' + a.id, 'PATCH', a.patch, storage); break;
        case 'archive_jobs': {
          for (const id of a.ids || []) await ask('jobs?id=eq.' + id, 'PATCH', { archived: true }, storage);
          out = { archived: (a.ids || []).length }; break;
        }
        case 'drivers': out = await ask('drivers?select=*', null, null, storage); break;
        case 'messages': out = await ask('messages?' + (a.job_id ? 'job_id=eq.' + a.job_id + '&' : '') + (a.sender_role ? 'sender_role=eq.' + a.sender_role : ''), null, null, storage); break;
        case 'locations': out = await ask('driver_locations?order=updated_at.desc', null, null, storage); break;
        case 'agent_memory': out = await ask('agent_memory?select=*', null, null, storage); break;
        case 'post_message': out = ((await ask('messages', 'POST', a, storage)) || [])[0] || a; break;
        case 'bin_shortfall': out = await ask('bin_shortfall?select=*', null, null, storage); break;
        case 'shopify_connection': out = await ask('shopify_connections?active=eq.true', null, null, storage); break;
        default: out = [];
      }
    } else {
      out = null;
    }
    if (out === undefined) out = null;
    if (c.fn === 'tp_org' && ['jobs', 'drivers', 'messages', 'locations', 'agent_memory', 'bin_shortfall', 'shopify_connection'].includes(c.action) && !Array.isArray(out)) out = [];
    return jsonResp(out);
  };
}

module.exports = { loadApp, wait, rpcCall, jsonResp, legacyRest };
