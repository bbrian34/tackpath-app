#!/usr/bin/env bash
# TackPath API v1, end to end with curl: submit an order, follow it, read its
# proof of delivery. Needs: TACKPATH_API_KEY (create one on developers.html), jq.
# Dispatch, PathIQ and the driver do their part in the TackPath apps; this
# script polls between the steps.
set -euo pipefail
API="${TACKPATH_API:-https://hofijsiphyjpdvujjzfi.supabase.co/functions/v1/api/v1}"
AUTH="Authorization: Bearer ${TACKPATH_API_KEY:?set TACKPATH_API_KEY}"

echo "1. Submit an order (safe to retry: same Idempotency-Key, same result)"
ORDER=$(curl -sS -X POST "$API/orders" -H "$AUTH" -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-SO-48213' -d '{
  "external_id": "SO-48213", "recipient_name": "Avery Collins", "address": "214 Maple Grove Ln, Marietta, GA 30064",
  "packages": 2, "tracking_number": "PCX4102322", "delivery_notes": "Leave at the side door" }')
echo "$ORDER" | jq '{id, status, tracking_number, route}'
ID=$(echo "$ORDER" | jq -r .id)

echo "2. Register a webhook (the secret is shown once: store it)"
curl -sS -X POST "$API/webhooks" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/tackpath/webhooks","events":["order.status_changed","delivery.completed","pod.available"]}' | jq '{id, secret}'

echo "3. Follow the order until it is delivered (or use the webhook)"
while :; do
  S=$(curl -sS "$API/orders/$ID" -H "$AUTH" | jq -r .status)
  echo "   status: $S"
  case "$S" in delivered|delivery_attempted|exception|cancelled) break ;; esac
  sleep 30
done
curl -sS "$API/orders/$ID/events" -H "$AUTH" | jq -r '.data[] | "\(.occurred_at)  \(.type)"'

echo "4. Proof of delivery (links work for 15 minutes)"
curl -sS "$API/orders/$ID/proof-of-delivery" -H "$AUTH" | jq '{delivered_at, recipient_name, delivery_method_label, media}'
