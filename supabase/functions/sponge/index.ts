// TackPath Sponge Agent - Supabase Edge Function
// Manually triggered. Reads GitHub source code and documentation, summarizes it,
// feeds structured knowledge into agent_memory so the Brain understands how TackPath actually works.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const SB_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";
const GITHUB_TOKEN = Deno.env.get("GITHUB_TOKEN") || "";
const REPO = "bbrian34/tackpath-app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Files Sponge reads and what it should learn from each
const TARGET_FILES = [
  { path: "knowledge/shopify_integration_guide.md", label: "Shopify Integration Guide", focus: "how merchants connect their store, technical permissions, common questions and answers" },
  { path: "knowledge/industry_2026.md", label: "Industry Knowledge Base", focus: "last-mile delivery market benchmarks, competitor landscape, technology trends, operational standards" },
  { path: "knowledge/policy_engine_guide.md", label: "Policy Engine Guide", focus: "how the Policy Engine, Route Recovery, Driver Agent, Command Agent, History, Onboarding, and Event Schema work together, what each piece actually does, current limitations" },
  { path: "guide.html", label: "Operator Guide", focus: "business rules, workflows, feature purpose" },
  { path: "dispatcher.html", label: "Dispatcher App", focus: "core dispatch logic, SmartSort clustering, SmartTrack exception detection, database schema fields used" },
  { path: "driver.html", label: "Driver App", focus: "driver workflow, scan flow, stop confirmation, GPS tracking" },
  { path: "policy-engine-recovery.html", label: "Policy Engine Prototype", focus: "deterministic rule evaluation, suppression logic, conflict detection, route recovery recommendation logic, event schema normalization -- functional prototype, not yet connected to live data" },
  { path: "supabase/functions/smartsort/index.ts", label: "Sam (SmartSort) Edge Function", focus: "server-side clustering algorithm, ETA calculation" },
  { path: "supabase/functions/swarm-watch/index.ts", label: "Todd + Brain Edge Function", focus: "exception detection thresholds, pattern detection logic" },
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SB_URL, SB_KEY);
  const results: any[] = [];

  try {
    for (const file of TARGET_FILES) {
      try {
        const ghResp = await fetch(
          `https://api.github.com/repos/${REPO}/contents/${file.path}`,
          {
            headers: GITHUB_TOKEN
              ? { Authorization: `token ${GITHUB_TOKEN}` }
              : {},
          }
        );

        if (!ghResp.ok) {
          results.push({ file: file.path, status: "fetch_failed", code: ghResp.status });
          continue;
        }

        const ghData = await ghResp.json();
        const content = atob(ghData.content.replace(/\n/g, ""));

        // Extract a summary -- key facts, not the raw code
        const summary = summarizeFile(file, content);

        // Log to agent_memory as foundational Sponge knowledge
        const { error: insertErr } = await supabase.from("agent_memory").insert({
          agent_name: "Sponge",
          event_type: "knowledge_learned",
          details: {
            file: file.path,
            label: file.label,
            focus: file.focus,
            summary: summary,
            file_size: content.length,
            learned_at: new Date().toISOString(),
          },
          outcome: "learned",
        });

        if (insertErr) {
          results.push({ file: file.path, status: "insert_failed", error: insertErr.message });
          continue;
        }

        results.push({ file: file.path, status: "learned", size: content.length });
      } catch (e: any) {
        results.push({ file: file.path, status: "error", message: e.message });
      }
    }

    return new Response(
      JSON.stringify({ success: true, files_processed: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// Extracts structured facts from each file type rather than storing raw code
function summarizeFile(file: any, content: string): string {
  const facts: string[] = [];

  if (file.path === "knowledge/industry_2026.md") {
    // Pull out section headers as a table of contents, plus key benchmark numbers
    const headers = [...content.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    facts.push(`Sections covered: ${headers.join(", ")}`);
    const boldFacts = [...content.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1].trim()).slice(0, 15);
    if (boldFacts.length) facts.push(`Key benchmarks: ${boldFacts.join(" | ")}`);
  }

  if (file.path === "knowledge/shopify_integration_guide.md") {
    const headers = [...content.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    facts.push(`Sections covered: ${headers.join(", ")}`);
    const questions = [...content.matchAll(/\*\*"([^"]+)"\*\*/g)].map((m) => m[1].trim());
    if (questions.length) facts.push(`FAQ topics: ${questions.join(" | ")}`);
  }

  if (file.path === "knowledge/policy_engine_guide.md") {
    const headers = [...content.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    facts.push(`Sections covered: ${headers.join(", ")}`);
    facts.push("Six connected pieces: Policy Engine (deterministic rule parsing/evaluation), Route Recovery Agent (reassignment recommendations), Driver Agent (plain-language event reporting), Command Agent (read-only query layer, makes no decisions), History/Audit (full decision log with approve/reject), Onboarding Agent (guided setup that creates real rules). Isolated prototype -- no live TackPath data, no Supabase, no backend, no LLM. Deterministic pattern-matching only, by design, so an LLM can later translate language into this same structure without ever making the decision itself.");
  }

  if (file.path === "guide.html") {
    // Pull out section headers as a table of contents of documented features
    const headers = [...content.matchAll(/<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi)]
      .map((m) => m[1].trim())
      .slice(0, 30);
    facts.push(`Documented sections: ${headers.join(", ")}`);
  }

  if (file.path === "dispatcher.html") {
    const funcs = [...content.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((n) => /^(run|render|load|assign|geocode|smart|swarm)/i.test(n));
    facts.push(`Key functions: ${[...new Set(funcs)].slice(0, 40).join(", ")}`);
    const tables = [...content.matchAll(/sbGet\('(\w+)\?/g)].map((m) => m[1]);
    facts.push(`Database tables referenced: ${[...new Set(tables)].join(", ")}`);
  }

  if (file.path === "driver.html") {
    const screens = [...content.matchAll(/id="(sc\w+)"/g)].map((m) => m[1]);
    facts.push(`Driver app screens: ${[...new Set(screens)].slice(0, 20).join(", ")}`);
  }

  if (file.path === "policy-engine-recovery.html") {
    const funcs = [...content.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)]
      .map((m) => m[1])
      .filter((n) => /^(parse|evaluate|normalize|render|handle|run|resolve|confirm|decide)/i.test(n));
    facts.push(`Key functions: ${[...new Set(funcs)].slice(0, 40).join(", ")}`);
    facts.push("Core entry points: parsePolicy(text) converts natural language to a structured rule. normalizeEvent(input) accepts either text or a structured object and produces one canonical event shape -- proven equivalent by test. evaluatePolicy(event, rules) resolves allow vs suppress by priority, defaults to suppression on a tie. evaluateRecovery() recommends stop reassignment using real distance/deadline math (straight-line distance, fixed average speed -- placeholder for real SmartTrack data).");
  }

  if (file.path.includes("smartsort")) {
    facts.push("Clusters geocoded stops via k-means++, sequences with nearest-neighbor, calculates traffic-aware ETA per leg plus handling time per stop, creates jobs with original_eta_at locked as fixed deadline.");
  }

  if (file.path.includes("swarm-watch")) {
    facts.push("Runs every minute via pg_cron. Checks in_transit jobs against original_eta_at deadline with 20 min tolerance. Flags exception, messages driver, logs to agent_memory. Also detects repeated-exception patterns across the day.");
  }

  return facts.join(" | ") || "No structured facts extracted -- raw file processed.";
}
