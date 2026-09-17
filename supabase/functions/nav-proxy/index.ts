// TackPath Navigation Proxy
// Proxies Directions API and Geocoding API calls from the driver app.
// The Google key lives in a server secret — it is never in the APK.
//
// Why this exists: fetch() in React Native does not append the
// X-Android-Package / X-Android-Cert attestation headers that Google Play
// Services adds to native SDK calls. Without those headers, an
// Android-package-restricted key rejects plain fetch() calls exactly as a
// referrer-restricted key does. Moving these two calls server-side removes
// the key from the APK bundle entirely.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const GKEY = Deno.env.get("GOOGLE_MAPS_KEY") || "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { action, params } = await req.json();

    if (action === "directions") {
      // params: { origin, destination, waypoints? }
      const { origin, destination, waypoints } = params;
      if (!origin || !destination) throw new Error("origin and destination required");

      let url = "https://maps.googleapis.com/maps/api/directions/json"
        + "?origin=" + encodeURIComponent(origin)
        + "&destination=" + encodeURIComponent(destination)
        + "&mode=driving"
        + "&departure_time=now"
        + "&traffic_model=best_guess"
        + "&units=imperial"
        + "&key=" + GKEY;

      if (waypoints && waypoints.length) {
        url += "&waypoints=" + waypoints.map((w: any) => `${w.lat},${w.lng}`).join("|");
      }

      const r = await fetch(url);
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    if (action === "geocode") {
      // params: { address }
      const { address } = params;
      if (!address) throw new Error("address required");

      const url = "https://maps.googleapis.com/maps/api/geocode/json"
        + "?address=" + encodeURIComponent(address)
        + "&key=" + GKEY;

      const r = await fetch(url);
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    throw new Error("unknown action: " + action);
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
