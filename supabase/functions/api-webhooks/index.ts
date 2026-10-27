// api-webhooks — sends queued API webhook events (signed, retried with backoff).
// Called every minute by pg_cron with the x-tp-cron-secret header (CRON_SECRET),
// like swarm-watch. A failing customer endpoint never affects dispatch: events are
// queued by the database and sent here, outside every operational transaction.
//
// Deploy with --no-verify-jwt. Secrets: SERVICE_ROLE_KEY, CRON_SECRET.
import { handleWebhookWorker, denoResolver } from "../_shared/tp_api.js";
import { serviceRpc } from "../_shared/tp_security.js";

const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const deps = {
  rpc: serviceRpc(SB_URL, Deno.env.get("SERVICE_ROLE_KEY") || ""),
  resolve: denoResolver(),
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  cronSecret: Deno.env.get("CRON_SECRET") || "",
  log: (...a: unknown[]) => console.error(...a),
};

Deno.serve(async (req: Request) => {
  let out;
  try { out = await handleWebhookWorker(req, deps); }
  catch (e) { deps.log("api-webhooks unexpected", (e as Error)?.message); out = { status: 500, body: { error: "unexpected failure" } }; }
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { "Content-Type": "application/json" } });
});
