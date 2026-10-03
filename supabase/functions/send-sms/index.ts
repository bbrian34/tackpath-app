// send-sms — driver assignment text ONLY (security hardening, Step 1)
//
// Before: anyone holding the public anon key could POST {to, body} and send
// any text to any number through TackPath's Twilio account.
// Now: the caller sends {session, job_id}. The database
// (tp_svc_assignment_sms) checks the dispatcher session, that the job is
// that company's, assigned, to exactly one driver who has sms_consent and a
// valid phone, applies rate limits (once per job per 10 min, 10/driver/hour,
// 30/driver/day, 200/company/day, 500/day overall) and builds the fixed
// message itself. Everything else is rejected.
//
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SERVICE_ROLE_KEY.
import { handleSendSms, serveJson, serviceRpc, twilioSms } from "../_shared/tp_security.js";

const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const TWILIO_FROM_NUMBER = "+16782745974"; // the approved TackPath number

Deno.serve(serveJson(handleSendSms, {
  rpc: serviceRpc(SB_URL, Deno.env.get("SERVICE_ROLE_KEY") || ""),
  sms: twilioSms(Deno.env.get("TWILIO_ACCOUNT_SID"), Deno.env.get("TWILIO_AUTH_TOKEN"), TWILIO_FROM_NUMBER),
  log: (...a: unknown[]) => console.error(...a),
}));
