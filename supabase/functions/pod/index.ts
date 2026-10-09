// pod — proof-of-delivery photos and signatures in the PRIVATE "pod" bucket.
//   {action:"upload", session:<driver>, job_id, stop, kind, content_type, data:<base64>} -> {path}
//   {action:"sign",   session:<company>, job_id, path}                                 -> {url} (1 hour)
// Only the driver assigned to the job can upload; only the job's company can view.
//
// Secret: SERVICE_ROLE_KEY.
import { handlePod, podStorage, serveJson, serviceRpc } from "../_shared/tp_security.js";

const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";

Deno.serve(serveJson(handlePod, {
  rpc: serviceRpc(SB_URL, KEY),
  storage: podStorage(SB_URL, KEY),
  log: (...a: unknown[]) => console.error(...a),
}));
