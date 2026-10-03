// driver-login — texts a one-time sign-in code to an approved driver.
// The code is created, stored hashed, expired (10 min), rate-limited
// (1/min and 5/hour per number, 300/hour overall) and checked in the
// database (tp_svc_driver_code / tp_driver_sign_in). The reviewer number
// +1 404 555 0199 is never texted; it uses the fixed review code.
//
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SERVICE_ROLE_KEY.
import { handleDriverLogin, serveJson, serviceRpc, twilioSms } from "../_shared/tp_security.js";

const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const TWILIO_FROM_NUMBER = "+16782745974";

Deno.serve(serveJson(handleDriverLogin, {
  rpc: serviceRpc(SB_URL, Deno.env.get("SERVICE_ROLE_KEY") || ""),
  sms: twilioSms(Deno.env.get("TWILIO_ACCOUNT_SID"), Deno.env.get("TWILIO_AUTH_TOKEN"), TWILIO_FROM_NUMBER),
  log: (...a: unknown[]) => console.error(...a),
}));
