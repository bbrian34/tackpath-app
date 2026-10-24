// Runs the real API handler (supabase/functions/_shared/tp_api.js) against the
// real migrations in PGlite. The service-role RPC, storage signing and DNS are
// the only stand-ins; the gateway, the triggers and every check are real.
import { handleApi, runWebhooks, handleWebhookWorker } from '../../supabase/functions/_shared/tp_api.js';
import { apiDb, orgSession, rpc, ORG_A, ORG_B, setOrgCode } from './db.mjs';

export { ORG_A, ORG_B, rpc };
export const BASE = 'https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/api/v1';
export const PUBLIC_DNS = { 'hooks.example.com': ['93.184.216.34'], 'api.shipper.example': ['93.184.216.35'] };

export async function setup({ dns = {} } = {}) {
  const db = await apiDb();
  const zones = { ...PUBLIC_DNS, ...dns };
  const signed = [];
  const deps = {
    rpc: async (fn, args) => {
      try { return { data: await rpc(db, fn, args, 'service_role') }; }
      catch (e) { return { error: { message: e.message } }; }
    },
    storage: { sign: async (path, seconds) => { signed.push({ path, seconds }); return { ok: true, url: `https://storage.test/sign/pod/${path}?token=t&e=${seconds}` }; } },
    resolve: async (host) => { if (!(host in zones)) throw new Error('NXDOMAIN'); return zones[host]; },
    log: () => {},
  };
  // one HTTP call: returns {status, body, headers}
  const call = async (method, path, { key, session, body, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (key) h.authorization = `Bearer ${key}`;
    if (session) h['x-tackpath-session'] = session;
    let payload;
    if (raw !== undefined) payload = raw;
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] ??= 'application/json'; }
    const res = await handleApi(new Request(BASE + path, { method, headers: h, body: payload }), deps);
    return res;
  };
  const sessionA = await orgSession(db);
  await setOrgCode(db, 'otherco', 'other-code-2026');
  const sessionB = await orgSession(db, 'otherco', 'other-code-2026');
  const newKey = async (session, body = {}) => {
    const r = await call('POST', '/admin/keys', { session, body: { name: 'Test key', ...body } });
    if (r.status !== 201) throw new Error('key create failed: ' + JSON.stringify(r.body));
    return r.body;
  };
  const org = (token) => (action, args = {}) => rpc(db, 'tp_org', { p_token: token, p_action: action, p_args: args });
  const driverSession = async (phone = '4045551234') => {
    const code = (await rpc(db, 'tp_svc_driver_code', { p_phone: phone }, 'service_role')).code;
    return (await rpc(db, 'tp_driver_sign_in', { p_phone: phone, p_code: code })).token;
  };
  const drv = (token) => (action, args = {}) => rpc(db, 'tp_driver', { p_token: token, p_action: action, p_args: args });
  return { db, deps, call, sessionA, sessionB, newKey, org, driverSession, drv, signed,
    webhooks: (extra = {}) => runWebhooks({ ...deps, ...extra }),
    worker: (req, extra = {}) => handleWebhookWorker(req, { ...deps, ...extra }) };
}

export const ORDER = (n = 1, extra = {}) => ({
  external_id: `SO-${1000 + n}`, recipient_name: 'Avery Collins', address: '214 Maple Grove Ln, Marietta, GA 30064',
  packages: 1, ...extra,
});
