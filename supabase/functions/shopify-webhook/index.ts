// TackPath Shopify Webhook Receiver - Supabase Edge Function
// Built at the fulfillment-order level per Shopify's 2026-2027 architecture guidance:
// one Shopify order can produce multiple fulfillment orders. Never assume 1 order = 1 job.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const SB_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";
const GKEY = "AIzaSyCZOSWrBATtsPI9KX76ZLzjMeDSNszCZk8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const shopDomain = req.headers.get("X-Shopify-Shop-Domain");
  const topic = req.headers.get("X-Shopify-Topic");

  try {
    const payload = await req.json();
    const supabase = createClient(SB_URL, SB_KEY);

    // Look up this shop's connection to get org_id and access token
    const { data: connection } = await supabase
      .from("shopify_connections")
      .select("*")
      .eq("shop_domain", shopDomain)
      .eq("active", true)
      .single();

    if (!connection) {
      return new Response(JSON.stringify({ success: false, error: "Unknown shop" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!connection.auto_dispatch) {
      return new Response(JSON.stringify({ success: true, note: "Auto-dispatch disabled for this connection" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fulfillment order webhook payload structure
    const fulfillmentOrder = payload.fulfillment_order || payload;
    const fulfillmentOrderId = String(fulfillmentOrder.id || "");
    const orderId = String(fulfillmentOrder.order_id || "");

    if (!fulfillmentOrderId) {
      return new Response(JSON.stringify({ success: false, error: "No fulfillment_order_id in payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Avoid creating a duplicate job for a fulfillment order we've already processed
    const { data: existingJob } = await supabase
      .from("jobs")
      .select("id")
      .eq("shopify_fulfillment_order_id", fulfillmentOrderId)
      .limit(1);

    if (existingJob && existingJob.length > 0) {
      return new Response(JSON.stringify({ success: true, note: "Already processed" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Pull the full order details via GraphQL to get customer address and line items --
    // the webhook payload alone often doesn't include everything needed for dispatch
    const gqlResp = await fetch(`https://${shopDomain}/admin/api/2026-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": connection.access_token,
      },
      body: JSON.stringify({
        query: `query getOrder($id: ID!) {
          order(id: $id) {
            name
            shippingAddress { address1 address2 city province zip }
            lineItems(first: 50) { edges { node { title quantity } } }
          }
        }`,
        variables: { id: `gid://shopify/Order/${orderId}` },
      }),
    });
    const gqlData = await gqlResp.json();
    const orderData = gqlData?.data?.order;

    if (!orderData || !orderData.shippingAddress) {
      await supabase.from("agent_memory").insert({
        agent_name: "ShopifyIntegration",
        event_type: "order_skipped",
        details: { reason: "No shipping address on order", shopify_order_id: orderId },
        outcome: "skipped",
      });
      return new Response(JSON.stringify({ success: true, note: "No shipping address, skipped" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const addr = orderData.shippingAddress;
    const fullAddress = [addr.address1, addr.address2, addr.city, addr.province, addr.zip]
      .filter(Boolean)
      .join(", ");
    const packageCount = orderData.lineItems.edges.reduce(
      (sum: number, e: any) => sum + (e.node.quantity || 1),
      0
    );

    // Geocode the delivery address
    let coords = null;
    try {
      const geoResp = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(fullAddress)}&key=${GKEY}`
      );
      const geoData = await geoResp.json();
      if (geoData.status === "OK" && geoData.results[0]) {
        coords = geoData.results[0].geometry.location;
      }
    } catch (e) {
      // Non-fatal -- job still gets created, geocoding can retry later
    }

    // Create the TackPath job at the fulfillment-order level
    const { data: job, error } = await supabase
      .from("jobs")
      .insert({
        title: `Shopify Order ${orderData.name}`,
        job_type: "sling",
        status: "pending",
        driver_name: null,
        pickup_address: shopDomain,
        dropoff_address: fullAddress,
        shopify_order_id: orderId,
        shopify_fulfillment_order_id: fulfillmentOrderId,
        source: "shopify",
        org_id: connection.org_id,
        priority: "normal",
        exception_flag: false,
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from("agent_memory").insert({
      agent_name: "ShopifyIntegration",
      event_type: "order_received",
      job_id: job.id,
      details: {
        shopify_order_id: orderId,
        shopify_fulfillment_order_id: fulfillmentOrderId,
        shop_domain: shopDomain,
        package_count: packageCount,
        address: fullAddress,
      },
      outcome: "job_created",
    });

    return new Response(
      JSON.stringify({ success: true, job_id: job.id, fulfillment_order_id: fulfillmentOrderId }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
