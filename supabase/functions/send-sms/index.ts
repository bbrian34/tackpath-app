// send-sms
//
// Real, minimal Supabase Edge Function that sends one SMS through
// Twilio's actual API. This is the piece confirmed missing earlier
// tonight - TackPath has never had real code to actually send a
// message, only the approved campaign and number to send it from.
//
// Scoped deliberately narrow, matching exactly what got approved:
// driver-only operational messages (assignment updates, route updates,
// dispatch notifications). Not built for customer messaging, not built
// for marketing, since that was never part of what was approved.

import { serve as baseServe } from "https://deno.land/std@0.168.0/http/server.ts";

// ── CORS (added 2026-09-24) ──
// Browsers send an OPTIONS "preflight" before calling this function from the
// dispatcher. Without an answer to it the real POST is never sent. Only
// TackPath's own site origin is allowed. Everything below is unchanged.
const ALLOWED_ORIGINS = ["https://tackpath.com", "https://www.tackpath.com"];
function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function serve(handler: (req: Request) => Promise<Response>) {
  return baseServe(async (req: Request) => {
    const cors = corsFor(req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const res = await handler(req);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  });
}

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
const TWILIO_FROM_NUMBER = "+16782745974"; // the real, approved TackPath number

serve(async (req) => {
  try {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return new Response(
        JSON.stringify({
          error: "Twilio credentials not fully configured",
          detail: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must both be set as Supabase secrets before this function can send anything real."
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const { to, body } = await req.json();

    if (!to || !body) {
      return new Response(
        JSON.stringify({ error: "Both 'to' (real phone number) and 'body' (message text) are required." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Real, direct call to Twilio's actual Messages API.
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

    const params = new URLSearchParams();
    params.append("To", to);
    params.append("From", TWILIO_FROM_NUMBER);
    params.append("Body", body);

    const twilioResp = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const twilioData = await twilioResp.json();

    if (!twilioResp.ok) {
      // Twilio's own real error - surfaced directly, not swallowed.
      // Common real cause at this exact stage: registration still
      // pending carrier-side, Twilio will say so explicitly here.
      return new Response(
        JSON.stringify({ error: "Twilio rejected the send", twilioError: twilioData }),
        { status: twilioResp.status, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, sid: twilioData.sid, status: twilioData.status }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (e) {
    return new Response(
      JSON.stringify({ error: "Unexpected failure", detail: e.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
