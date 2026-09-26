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

    if (action === "routes") {
      // params: { origin: "lat,lng", destination: "lat,lng" }
      // Used by the dispatcher for live ETA calculation.
      const { origin, destination } = params;
      if (!origin || !destination) throw new Error("origin and destination required");

      const [oLat, oLng] = origin.split(",").map(Number);
      const [dLat, dLng] = destination.split(",").map(Number);

      const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GKEY,
          "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: oLat, longitude: oLng } } },
          destination: { location: { latLng: { latitude: dLat, longitude: dLng } } },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
          // A bare "now" can already read as past-tense by the time this
          // reaches Google, which rejects the whole request outright.
          // Confirmed broken in production 2026-09-25: every live ETA
          // refresh was failing with "Timestamp must be set to a future
          // time." A small forward buffer keeps it safely in the future.
          departureTime: new Date(Date.now()+60000).toISOString(),
        }),
      });
      const data = await r.json();
      return new Response(JSON.stringify(data), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ── ROAD MATRIX (added 2026-09-25, Increment 2) ──
    // Purely additive: a new action alongside directions/geocode/routes.
    // Nothing existing is changed or removed.
    //
    // params: { origins:[{lat,lng},...], destinations:[{lat,lng},...] }
    // Caller (dispatcher.html) is responsible for keeping
    // origins.length * destinations.length <= 625 per call -- this proxy
    // makes exactly one computeRouteMatrix request per call, it does not
    // itself chunk or retry. Chunking/retry/backoff live client-side so
    // they can be unit-tested with mocked responses.
    if (action === "matrix") {
      const { origins, destinations } = params;
      if (!Array.isArray(origins) || !origins.length) throw new Error("origins required");
      if (!Array.isArray(destinations) || !destinations.length) throw new Error("destinations required");
      if (origins.length * destinations.length > 625) {
        throw new Error("matrix request exceeds 625 elements; chunk before calling");
      }

      const toWaypoint = (p: any) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });

      const r = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GKEY,
          // status and condition are BOTH required in the mask -- Google's own
          // docs warn that every element silently looks OK without "status"
          // explicitly requested, and "condition" is the only field that
          // distinguishes a confirmed no-route from a successful computation.
          "X-Goog-FieldMask": "originIndex,destinationIndex,status,condition,distanceMeters,duration",
        },
        body: JSON.stringify({
          origins: origins.map(toWaypoint),
          destinations: destinations.map(toWaypoint),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
          // A bare "now" can already read as past-tense by the time this
          // reaches Google, which rejects it outright. A small forward
          // buffer keeps it safely in the future every time.
          departureTime: params.departureTime || new Date(Date.now()+60000).toISOString(),
        }),
      });
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
