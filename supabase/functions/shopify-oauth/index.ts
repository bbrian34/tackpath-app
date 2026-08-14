// TackPath Shopify OAuth - Supabase Edge Function
// Handles the install flow: redirect to Shopify authorization, then token exchange on callback

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = "https://hofijsiphyjpdvujjzfi.supabase.co";
const SB_KEY = Deno.env.get("SERVICE_ROLE_KEY") || "";
const SHOPIFY_API_KEY = Deno.env.get("SHOPIFY_API_KEY") || "";
const SHOPIFY_API_SECRET = Deno.env.get("SHOPIFY_API_SECRET") || "";
const APP_URL = "https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/shopify-oauth";
const SCOPES = "read_orders,read_fulfillments,write_fulfillments,read_locations";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const shop = url.searchParams.get("shop");
  const code = url.searchParams.get("code");
  const orgId = url.searchParams.get("org_id");

  try {
    // Step 1: No code yet -- redirect merchant to Shopify's authorization screen
    if (shop && !code) {
      if (!shop.endsWith(".myshopify.com")) {
        return new Response("Invalid shop domain", { status: 400, headers: corsHeaders });
      }
      const state = orgId || "";
      const installUrl =
        `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}` +
        `&scope=${SCOPES}&redirect_uri=${encodeURIComponent(APP_URL)}` +
        `&state=${encodeURIComponent(state)}`;
      return Response.redirect(installUrl, 302);
    }

    // Step 2: Callback with authorization code -- exchange for a permanent access token
    if (shop && code) {
      const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: SHOPIFY_API_KEY,
          client_secret: SHOPIFY_API_SECRET,
          code,
        }),
      });
      const tokenData = await tokenResp.json();

      if (!tokenData.access_token) {
        return new Response("Token exchange failed", { status: 400, headers: corsHeaders });
      }

      const state = url.searchParams.get("state") || null;
      const supabase = createClient(SB_URL, SB_KEY);

      await supabase.from("shopify_connections").upsert(
        {
          shop_domain: shop,
          access_token: tokenData.access_token,
          scope: tokenData.scope,
          org_id: state || null,
          active: true,
        },
        { onConflict: "shop_domain" }
      );

      // Register the fulfillment order webhook so new orders flow in automatically
      await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": tokenData.access_token,
        },
        body: JSON.stringify({
          query: `mutation {
            webhookSubscriptionCreate(
              topic: FULFILLMENT_ORDERS_FULFILLMENT_REQUEST_SUBMITTED
              webhookSubscription: {
                callbackUrl: "https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/shopify-webhook"
                format: JSON
              }
            ) {
              webhookSubscription { id }
              userErrors { field message }
            }
          }`,
        }),
      });

      return new Response(
        `<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#010e21;color:#eef4ff;">
          <h2>TackPath connected to ${shop}</h2>
          <p>Orders will now flow into your dispatch board automatically.</p>
          <a href="https://tackpath.com/dispatcher.html" style="color:#19b7ef;">Return to TackPath</a>
        </body></html>`,
        { headers: { ...corsHeaders, "Content-Type": "text/html" } }
      );
    }

    return new Response("Missing shop parameter", { status: 400, headers: corsHeaders });
  } catch (e: any) {
    return new Response("Error: " + e.message, { status: 500, headers: corsHeaders });
  }
});
