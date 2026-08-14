// TackPath Swarm Watch - Supabase Edge Function
// Runs on a schedule (pg_cron), independent of any browser tab
// Combines SmartTrack (Todd) exception detection + Swarm Coordinator (Brain) pattern analysis

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GKEY = "AIzaSyCZOSWrBATtsPI9KX76ZLzjMeDSNszCZk8";
const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const SB_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LATE_TOLERANCE_MIN = 20;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SB_URL, SB_KEY);
  const results = { exceptions_flagged: 0, patterns_detected: 0, errors: [] as string[] };

  try {
    // ── TODD: check every active job for stops past their locked deadline ──
    const { data: activeJobs, error: jobsErr } = await supabase
      .from("jobs")
      .select("*")
      .in("status", ["in_transit", "customer_confirmed"]);

    if (jobsErr) throw jobsErr;

    for (const job of activeJobs || []) {
      if (!job.driver_name || job.exception_flag) continue;

      let stops = job.surge_stops;
      if (typeof stops === "string") {
        try { stops = JSON.parse(stops); } catch (e) { stops = null; }
      }
      if (!stops || !Array.isArray(stops)) continue;

      const totalStops = stops.filter((s: any) => !s.cancelled).length;
      const doneStops = job.stops_completed || 0;
      if (doneStops >= totalStops) continue;

      // Use original_eta_at as the fixed deadline reference (matches browser logic)
      const deadline = job.original_eta_at || job.estimated_delivery_at;
      if (!deadline) continue;

      const minsLate = Math.round((Date.now() - new Date(deadline).getTime()) / 60000);

      if (minsLate >= LATE_TOLERANCE_MIN) {
        // Flag the exception
        await supabase.from("jobs").update({ exception_flag: true }).eq("id", job.id);

        // Post alert to comms
        await supabase.from("messages").insert({
          job_id: job.id,
          sender: "SmartTrack",
          sender_role: "dispatcher",
          body: `SMARTTRACK:: ${job.driver_name} is ${minsLate} min past expected arrival at stop ${doneStops + 1} of ${totalStops}. Auto-flagged as exception (server-side check).`,
        });

        // Message the driver
        const firstName = job.driver_name.split(" ")[0];
        await supabase.from("messages").insert({
          job_id: job.id,
          sender: "SmartTrack",
          sender_role: "dispatcher",
          body: `Hey ${firstName}, you are running behind on stop ${doneStops + 1}. Everything ok? Let us know if you need anything.`,
        });

        // Log to agent memory
        await supabase.from("agent_memory").insert({
          agent_name: "SmartTrack",
          event_type: "stop_past_eta",
          job_id: job.id,
          driver_name: job.driver_name,
          details: { minutes_late: minsLate, stop_number: doneStops + 1, total_stops: totalStops, source: "edge_function" },
          outcome: "escalated",
        });

        results.exceptions_flagged++;
      }
    }

    // ── BRAIN: pattern detection across today's agent_memory activity ──
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: recentEvents } = await supabase
      .from("agent_memory")
      .select("*")
      .gte("created_at", todayStart.toISOString())
      .order("created_at", { ascending: false })
      .limit(100);

    const trackEvents = (recentEvents || []).filter(
      (e: any) => e.agent_name === "SmartTrack" && e.event_type === "stop_past_eta"
    );

    if (trackEvents.length >= 3) {
      // Check if this pattern was already flagged today
      const { data: existingPattern } = await supabase
        .from("agent_memory")
        .select("id")
        .eq("agent_name", "SwarmCoordinator")
        .eq("event_type", "pattern_detected")
        .gte("created_at", todayStart.toISOString())
        .limit(1);

      if (!existingPattern || existingPattern.length === 0) {
        const driverNames = [...new Set(trackEvents.map((e: any) => e.driver_name))];
        const insight = `${trackEvents.length} delivery exceptions flagged today across ${driverNames.length} driver(s). Worth reviewing whether SmartSort route estimates need adjustment for current conditions.`;

        await supabase.from("agent_memory").insert({
          agent_name: "SwarmCoordinator",
          event_type: "pattern_detected",
          details: {
            pattern: "repeated_exceptions",
            exception_count: trackEvents.length,
            affected_drivers: driverNames,
            insight,
            source: "edge_function",
          },
          outcome: "flagged",
        });

        results.patterns_detected++;
      }
    }

  } catch (e: any) {
    results.errors.push(e.message);
  }

  return new Response(JSON.stringify({ success: true, ...results }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
