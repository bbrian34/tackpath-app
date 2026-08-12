// TackPath SmartSort Agent - Supabase Edge Function
// Receives manifest packages, clusters geographically, creates jobs, broadcasts to drivers

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GKEY = "AIzaSyCZOSWrBATtsPI9KX76ZLzjMeDSNszCZk8";
const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

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

    // Step 1: Geocode all addresses
    const geocoded = [];
    const failed = [];
    for (const pkg of packages) {
      try {
        const res = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(pkg.address)}&key=${GKEY}`
        );
        const data = await res.json();
        if (data.status === "OK" && data.results[0]) {
          const loc = data.results[0].geometry.location;
          geocoded.push({ ...pkg, coords: { lat: loc.lat, lng: loc.lng } });
        } else {
          failed.push(pkg);
        }
      } catch (e) {
        failed.push(pkg);
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

      const { data: job, error } = await supabase
        .from("jobs")
        .insert({
          title: `Surge Route ${masterCode}`,
          job_type: "surge",
          status: "pending",
          pickup_address: pickup,
          dropoff_address: dropoff,
          surge_stops: stopsWithId,
          stops_completed: 0,
          org_id: org_id || null,
          priority: "normal",
          exception_flag: false,
        })
        .select()
        .single();

      if (error) throw error;
      results.push({ job_id: job.id, master_code: masterCode, stops: stops.length, packages: totalPkgsInRoute });
    }

    // Step 6: Broadcast all jobs to available drivers
    for (const result of results) {
      await supabase
        .from("jobs")
        .update({ status: "assigned" })
        .eq("id", result.job_id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        clusters: results.length,
        total_packages: totalPkgs,
        failed_addresses: failed.length,
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
