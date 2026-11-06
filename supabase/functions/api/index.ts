// api — TackPath Public API v1 (https://<project>.supabase.co/functions/v1/api/v1/...).
// Customers authenticate with their own API key (Authorization: Bearer tpk_live_...);
// the developer page uses a company session (X-TackPath-Session). Every request is
// authorized, scoped to one company, rate limited and audited by the database
// gateway public.tp_svc_api (migration 69). See docs/api/.
//
// Deploy with --no-verify-jwt (the API key is not a Supabase JWT).
// Secret: SERVICE_ROLE_KEY (server side only; never sent to customers).
import { serveApi, denoResolver } from "../_shared/tp_api.js";
import { podStorage, serviceRpc } from "../_shared/tp_security.js";

const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";

Deno.serve(serveApi({
  rpc: serviceRpc(SB_URL, KEY),
  storage: podStorage(SB_URL, KEY),
  resolve: denoResolver(),
  log: (...a: unknown[]) => console.error(...a),
}));
