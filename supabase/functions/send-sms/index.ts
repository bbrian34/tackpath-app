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

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
