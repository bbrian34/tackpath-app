// TackPath Swarm Watch - Supabase Edge Function
// Runs on a schedule (pg_cron), independent of any browser tab.
// Runs the operations loop (migration 70, tp_sec.ops_tick) company by company:
//   SmartTrack (Todd)       drivers past the deadline locked for their current stop
//   SmartComms (Mario)      30-minute check-ins and end-of-route confirmations
//   Ruby                    what drivers said today, each message categorised once
//   Swarm Coordinator       patterns across the company's agent activity
//   Promise watch           every remaining stop predicted against its delivery promise
//   Decisions               each issue, its prediction, recommendation, approval and measured outcome
// Every action is claimed first (tp_sec.agent_actions), so overlapping runs or an
// open dispatcher tab can never send the same message twice. All rows carry their company.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { guardRequest, serviceRpc } from "../_shared/tp_security.js";

const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const SB_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Security hardening 2026-10: only company sessions, or the scheduler with the x-tp-cron-secret header (CRON_SECRET) may call this.
  const guard = await guardRequest(req, {
    rpc: serviceRpc("https://hofijsiphyjpdvujjzfi.supabase.co", Deno.env.get("SERVICE_ROLE_KEY") || ""),
    cronSecret: Deno.env.get("CRON_SECRET") || "",
  }, { kinds: ["org"], cors: corsHeaders });
  if (guard.response) return guard.response;
  req = guard.req;

  // The scheduler runs every company; a signed-in company runs only its own routes.
  const org_id = guard.session.kind === "org" ? guard.session.org_id : null;
  const rpc = serviceRpc(SB_URL, SB_KEY);
  const r = await rpc("tp_svc_ops_tick", { p_org: org_id });
  if (r.error) {
    return new Response(JSON.stringify({ success: false, error: r.error.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ success: true, ...(r.data || {}) }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
