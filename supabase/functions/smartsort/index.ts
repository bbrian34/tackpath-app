// TackPath SmartSort Agent - Supabase Edge Function
// Receives manifest packages, clusters geographically, creates jobs, broadcasts to drivers

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Server-side key is read from the function secret, never committed.
// Set with: supabase secrets set GOOGLE_MAPS_KEY=...
const GKEY = Deno.env.get("GOOGLE_MAPS_KEY") || "";
const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const SB_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { packages, org_id, pkgs_per_driver } = await req.json();
    if (!packages || !packages.length) throw new Error("No packages provided");

    const supabase = createClient(SB_URL, SB_KEY);
    const perDriver = pkgs_per_driver || 26;

    // Step 1: Geocode all addresses — writing results to the addresses table
    // so the same address is never geocoded twice across any session or user,
    // and failed geocodes become actionable events instead of a silent count.
    const geocoded = [];
    const failed = [];
    for (const pkg of packages) {
      // Check the shared address cache first. If TackPath has already
      // geocoded and validated this address, reuse the result rather than
      // calling Google again. This is what Marco's cache was always supposed
      // to be — it just lived in a browser tab before, dying on every refresh.
      let cachedCoords: any = null;
      if (org_id && pkg.address) {
        const norm = pkg.address.trim().toUpperCase();
        const { data: cached } = await supabase
          .from("addresses")
          .select("lat,lng,geocode_precision,geocode_failures")
          .eq("org_id", org_id)
          .eq("normalized_address", norm)
          .single();
        if (cached && cached.lat && cached.lng && cached.geocode_failures === 0) {
          cachedCoords = { lat: cached.lat, lng: cached.lng };
        }
      }

      if (cachedCoords) {
        geocoded.push({ ...pkg, coords: cachedCoords });
        continue;
      }

      try {
        const res = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(pkg.address)}&key=${GKEY}`
        );
        const data = await res.json();
        if (data.status === "OK" && data.results[0]) {
          const loc = data.results[0].geometry.location;
          const precision = data.results[0].geometry.location_type || "UNKNOWN";
          const normalized = (data.results[0].formatted_address || pkg.address).trim().toUpperCase();
          const coords = { lat: loc.lat, lng: loc.lng };
          geocoded.push({ ...pkg, coords });

          // Persist to the shared address table. On conflict (same address,
          // same org), update the coordinates and mark it verified now.
          if (org_id) {
            await supabase.from("addresses").upsert({
              org_id,
              normalized_address: normalized,
              lat: loc.lat,
              lng: loc.lng,
              geocode_precision: precision,
              geocode_failures: 0,
              last_verified_at: new Date().toISOString(),
            }, { onConflict: "org_id,normalized_address", ignoreDuplicates: false });
          }
        } else {
          failed.push({ ...pkg, geocode_status: data.status, geocode_error: data.error_message || null });

          // Failed geocodes are now events, not a silent count. The dispatcher
          // can query these before dispatch and surface them as an actionable
          // queue rather than discovering them after a customer calls.
          if (org_id) {
            await supabase.from("events").insert({
              org_id,
              event_type: "package.geocode_failed",
              payload: {
                tracking_number: pkg.tracking_number || pkg.order_id || null,
                raw_address: pkg.address,
                recipient: pkg.recipient || null,
                geocode_status: data.status,
                geocode_error: data.error_message || null,
                manifest_run: new Date().toISOString(),
              },
              idempotency_key: null, // each manifest run should produce its own failure record
            });

            // Also increment the failure counter on the address so TackPath
            // can eventually say "this address has failed 4 times."
            const norm = pkg.address.trim().toUpperCase();
            await supabase.rpc("increment_address_failures", {
              p_org_id: org_id,
              p_address: norm,
            }).catch(() => {}); // non-fatal if the RPC doesn't exist yet
          }
        }
      } catch (e) {
        failed.push({ ...pkg, geocode_status: "EXCEPTION", geocode_error: String(e) });
        if (org_id) {
          await supabase.from("events").insert({
            org_id,
            event_type: "package.geocode_failed",
            payload: {
              tracking_number: pkg.tracking_number || pkg.order_id || null,
              raw_address: pkg.address,
              recipient: pkg.recipient || null,
              geocode_status: "EXCEPTION",
              geocode_error: String(e),
              manifest_run: new Date().toISOString(),
            },
            idempotency_key: null,
          });
        }
      }
    }

    if (!geocoded.length) throw new Error("No addresses could be geocoded");

    // Step 2: Calculate total packages and driver count
    const totalPkgs = geocoded.reduce((s: number, p: any) => s + (parseInt(p.packages) || 1), 0);
    const k = Math.min(200, Math.max(1, Math.round(totalPkgs / perDriver)));

    // Step 3: k-means++ clustering
    const clusters = smartCluster(geocoded, k);

    // Step 4: Sequence each cluster with nearest-neighbor
    const sequenced = clusters.map((cluster: any[]) => nearestNeighborSort(cluster));

    // Step 5: Create jobs in Supabase
    const results = [];
    for (let i = 0; i < sequenced.length; i++) {
      const stops = sequenced[i];
      const masterCode = "TP-ROUTE-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      const stopsWithId = stops.map((s: any, idx: number) => ({
        ...s,
        stop_number: idx + 1,
        smart_id: `${s.order_id}-${idx + 1}`,
        status: "pending",
      }));

      const totalPkgsInRoute = stops.reduce((s: number, p: any) => s + (parseInt(p.packages) || 1), 0);
      const pickup = stops[0]?.address || "Warehouse";
      const dropoff = stops[stops.length - 1]?.address || "";

      // Calculate real traffic-aware route duration plus per-stop handling time
      const routeSeconds = await getTrafficAwareRouteSeconds(stopsWithId);
      const etaTimestamp = new Date(Date.now() + routeSeconds * 1000).toISOString();

      const { data: job, error } = await supabase
        .from("jobs")
        .insert({
          title: `Surge Route ${masterCode}`,
          bin_label: `${i + 1}A`,
          job_type: "surge",
          status: "pending",
          driver_name: null,
          pickup_address: pickup,
          dropoff_address: dropoff,
          surge_stops: stopsWithId,
          stops_completed: 0,
          org_id: org_id || null,
          priority: "normal",
          exception_flag: false,
          estimated_delivery_at: etaTimestamp,
          original_eta_at: etaTimestamp,
        })
        .select()
        .single();

      if (error) throw error;
      results.push({ job_id: job.id, master_code: masterCode, stops: stops.length, packages: totalPkgsInRoute });
    }

    // Step 6: Jobs are created as 'pending' - drivers see them and accept (first-accept mechanic)
    // No need to update status - pending jobs are visible to all drivers

    // Write package.manifested events for every package in this run.
    // A package now has a durable identity from the moment the manifest
    // is uploaded — before it is sorted, stowed, or delivered.
    if (org_id && packages.length) {
      const manifestedEvents = packages.map((pkg: any) => ({
        org_id,
        event_type: "package.manifested",
        payload: {
          tracking_number: pkg.tracking_number || pkg.order_id || null,
          recipient: pkg.recipient || null,
          raw_address: pkg.address,
          geocoded: geocoded.some((g: any) =>
            (g.tracking_number || g.order_id) === (pkg.tracking_number || pkg.order_id)
          ),
          manifest_run: new Date().toISOString(),
        },
        idempotency_key: org_id + ":manifest:" + (pkg.tracking_number || pkg.order_id || pkg.address) + ":" + new Date().toDateString(),
      }));
      await supabase.from("events").upsert(manifestedEvents, {
        onConflict: "idempotency_key",
        ignoreDuplicates: true,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        clusters: results.length,
        total_packages: totalPkgs,
        failed_count: failed.length,
        // Return the actual failed packages so the dispatcher can surface
        // them as an actionable queue — not just a number that tells the
        // operator almost nothing.
        failed_packages: failed.map((p: any) => ({
          tracking_number: p.tracking_number || p.order_id || null,
          recipient: p.recipient || null,
          address: p.address,
          reason: p.geocode_status || "UNKNOWN",
          error: p.geocode_error || null,
        })),
        jobs: results,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (e: any) {
    return new Response(
      JSON.stringify({ success: false, error: e.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// ── GEOSPATIAL CLUSTERING ──

// ── LIVE TRAFFIC ETA (matches browser dispatcher fix) ──
async function getTrafficAwareLegSeconds(originCoords: any, destCoords: any): Promise<number | null> {
  try {
    const resp = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GKEY,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: originCoords.lat, longitude: originCoords.lng } } },
        destination: { location: { latLng: { latitude: destCoords.lat, longitude: destCoords.lng } } },
        travelMode: "DRIVE",
        routingPreference: "TRAFFIC_AWARE",
        departureTime: new Date().toISOString(),
      }),
    });
    const data = await resp.json();
    if (data.routes && data.routes[0] && data.routes[0].duration) {
      const seconds = parseInt(data.routes[0].duration.replace("s", ""));
      if (!isNaN(seconds)) return seconds;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function getTrafficAwareRouteSeconds(stops: any[]): Promise<number> {
  const MINUTES_PER_STOP_HANDLING = 4;
  let totalSeconds = 0;

  for (let i = 0; i < stops.length - 1; i++) {
    if (stops[i].coords && stops[i + 1].coords) {
      const legSeconds = await getTrafficAwareLegSeconds(stops[i].coords, stops[i + 1].coords);
      if (legSeconds !== null) {
        totalSeconds += legSeconds;
        continue;
      }
    }
    totalSeconds += 6 * 60; // fallback drive time for missing coords or failed API call
  }

  totalSeconds += stops.length * MINUTES_PER_STOP_HANDLING * 60;
  return totalSeconds;
}

function haversine(a: any, b: any): number {
  const R = 3958.8;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

function smartCluster(stops: any[], k: number): any[][] {
  if (stops.length === 0) return [];
  if (k <= 1) return [stops];
  const actualK = Math.min(k, stops.length);

  // k-means++ seeding
  const centroids: any[] = [];
  const used = new Set<number>();
  const avgLat = stops.reduce((s, p) => s + p.coords.lat, 0) / stops.length;
  const avgLng = stops.reduce((s, p) => s + p.coords.lng, 0) / stops.length;
  let firstIdx = 0, firstDist = Infinity;
  for (let i = 0; i < stops.length; i++) {
    const d = haversine(stops[i].coords, { lat: avgLat, lng: avgLng });
    if (d < firstDist) { firstDist = d; firstIdx = i; }
  }
  centroids.push({ lat: stops[firstIdx].coords.lat, lng: stops[firstIdx].coords.lng });
  used.add(firstIdx);

  while (centroids.length < actualK) {
    let bestIdx = 0, bestDist = -1;
    for (let i = 0; i < stops.length; i++) {
      if (used.has(i)) continue;
      const minD = Math.min(...centroids.map(c => haversine(stops[i].coords, c)));
      if (minD > bestDist) { bestDist = minD; bestIdx = i; }
    }
    centroids.push({ lat: stops[bestIdx].coords.lat, lng: stops[bestIdx].coords.lng });
    used.add(bestIdx);
  }

  // k-means iterations
  let assignments = new Array(stops.length).fill(0);
  for (let iter = 0; iter < 25; iter++) {
    let changed = false;
    for (let i = 0; i < stops.length; i++) {
      let bestC = 0, bestDist = Infinity;
      for (let c = 0; c < actualK; c++) {
        const d = haversine(stops[i].coords, centroids[c]);
        if (d < bestDist) { bestDist = d; bestC = c; }
      }
      if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
    }
    if (!changed) break;
    const sums = Array.from({ length: actualK }, () => ({ lat: 0, lng: 0, n: 0 }));
    for (let i = 0; i < stops.length; i++) {
      sums[assignments[i]].lat += stops[i].coords.lat;
      sums[assignments[i]].lng += stops[i].coords.lng;
      sums[assignments[i]].n++;
    }
    for (let c = 0; c < actualK; c++) {
      if (sums[c].n > 0) { centroids[c].lat = sums[c].lat / sums[c].n; centroids[c].lng = sums[c].lng / sums[c].n; }
    }
  }

  const clusters: any[][] = Array.from({ length: actualK }, () => []);
  for (let i = 0; i < stops.length; i++) clusters[assignments[i]].push(stops[i]);

  // Equalize package counts
  const totalPkgs = stops.reduce((s, p) => s + (parseInt(p.packages) || 1), 0);
  const targetPkgs = Math.round(totalPkgs / actualK);
  equalizePackages(clusters, targetPkgs, centroids);

  return clusters.filter(c => c.length > 0);
}

function equalizePackages(clusters: any[][], target: number, centroids: any[]) {
  const tolerance = Math.ceil(target * 0.15);
  for (let pass = 0; pass < 5; pass++) {
    let balanced = true;
    for (let i = 0; i < clusters.length; i++) {
      const iPkgs = clusters[i].reduce((s, p) => s + (parseInt(p.packages) || 1), 0);
      if (iPkgs > target + tolerance) {
        let bestJ = -1, bestDist = Infinity;
        for (let j = 0; j < clusters.length; j++) {
          if (j === i) continue;
          const jPkgs = clusters[j].reduce((s, p) => s + (parseInt(p.packages) || 1), 0);
          if (jPkgs < target - tolerance) {
            const d = haversine(centroids[i], centroids[j]);
            if (d < bestDist) { bestDist = d; bestJ = j; }
          }
        }
        if (bestJ >= 0) {
          let moveIdx = 0, moveDist = Infinity;
          for (let s = 0; s < clusters[i].length; s++) {
            const d = haversine(clusters[i][s].coords, centroids[bestJ]);
            if (d < moveDist) { moveDist = d; moveIdx = s; }
          }
          clusters[bestJ].push(clusters[i].splice(moveIdx, 1)[0]);
          balanced = false;
        }
      }
    }
    if (balanced) break;
  }
}

function nearestNeighborSort(stops: any[]): any[] {
  if (stops.length <= 1) return stops;
  const remaining = [...stops];
  const sorted = [remaining.shift()!];
  while (remaining.length > 0) {
    const last = sorted[sorted.length - 1];
    let nearestIdx = 0, nearestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(last.coords, remaining[i].coords);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    }
    sorted.push(remaining.splice(nearestIdx, 1)[0]);
  }
  return sorted;
}
