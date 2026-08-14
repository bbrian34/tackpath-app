# TackPath Shopify Integration — Reference Guide

## What it does
Connects a merchant's Shopify store directly to TackPath. Every new order automatically becomes a delivery job on the dispatch board — no manual entry, no CSV uploads for online orders.

## How a merchant connects their store

1. In the TackPath dispatcher, go to the **Command Center** panel and find **Integrations → Shopify**.
2. Click **Connect**.
3. Enter their Shopify store domain, formatted exactly like: `theirstorename.myshopify.com`
4. They'll be redirected to Shopify's own authorization screen, showing what TackPath is requesting access to.
5. They click **Install app** (or similar) on Shopify's side.
6. Shopify redirects back to TackPath, confirms the connection, and TackPath automatically sets up a webhook so new orders start flowing in immediately — no further setup needed.

That's the entire process from the merchant's side — one click to authorize, nothing else to configure manually.

## What TackPath actually does with each order

- Reads the order's shipping address and line items
- Converts the address into map coordinates
- Creates a delivery job on your dispatch board, tagged as coming from Shopify
- The job then goes through the exact same SmartSort clustering and dispatch process as any manually uploaded order

## What TackPath requests access to (the technical permissions)

- **Read orders** — to see order details
- **Read/write fulfillments** — to read fulfillment info and mark orders fulfilled once delivered
- **Read locations** — to know which store location an order ships from, for stores with multiple locations

TackPath does **not** request access to customer payment information, store theme/design, discounts, or anything unrelated to order fulfillment.

## Common questions and answers

**"Will this work with multiple store locations?"**
Yes — TackPath reads the fulfillment location for each order, which matters for stores using Shopify's newer split-shipping and multi-location features.

**"What if an order has some items shipped and some picked up in-store?"**
TackPath is built to handle this correctly. Shopify can split a single order into multiple "fulfillment orders" — TackPath creates a separate delivery job for each shipping-eligible piece, and correctly ignores in-store pickup portions since those don't need a driver.

**"Do I have to do anything for each new order?"**
No — once connected, every eligible order flows in automatically. No manual action needed unless auto-dispatch is turned off.

**"Can I turn off automatic order flow without disconnecting?"**
Yes — each connection has an auto-dispatch toggle. Turning it off pauses new orders from becoming jobs without removing the Shopify connection itself.

**"Is my Shopify data secure?"**
The connection uses Shopify's standard OAuth authorization — the same method used by every legitimate Shopify app. TackPath never sees or stores payment/card information; Shopify handles all payment processing separately.

**"What happens if I disconnect Shopify from TackPath?"**
Existing jobs already created stay in TackPath. No new orders will flow in once disconnected. Reconnecting later does not create duplicate jobs for orders already processed.

**"Does this work with any Shopify plan?"**
Basic OAuth and standard order/fulfillment access works on all Shopify plans. Split shipping and ship-and-pickup features are currently limited to Shopify Plus and Enterprise plans on Shopify's side — TackPath supports both scenarios either way.

**"How fast do orders show up after checkout?"**
Near-instant — TackPath uses Shopify's webhook system, meaning it's notified the moment an order's fulfillment is ready, not on a delay or polling schedule.

## Technical reference (for your own use)

- OAuth install/callback: `https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/shopify-oauth`
- Webhook receiver: `https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/shopify-webhook`
- Scopes requested: `read_orders, read_fulfillments, write_fulfillments, read_locations`
- Data stored: `shopify_connections` table (shop domain, access token, org, settings) and `jobs` table (tagged with `source: 'shopify'`, linked to the Shopify order and fulfillment order IDs)
- Architecture: built at the **fulfillment-order level**, matching Shopify's 2026-2027 requirement that apps not assume one order equals one delivery
