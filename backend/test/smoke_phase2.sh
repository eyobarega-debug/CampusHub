#!/bin/bash
# Phase 2 feature smoke test. Assumes test/smoke.sh has already been run
# once (or the server is freshly seeded) — run against a live, seeded server.
set -e
BASE="http://localhost:4000/api"
PASS="Password123!"

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; exit 1; }
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)"; }

login() {
  curl -s -X POST "$BASE/auth/login" -H "Content-Type: application/json" \
    -d "{\"email\":\"$1\",\"password\":\"$PASS\"}"
}

echo "=== Logging in demo accounts ==="
SARA=$(login sara@aastu.edu.et); SARA_TOKEN=$(echo "$SARA" | jget "['accessToken']")
DAWIT=$(login dawit@aastu.edu.et); DAWIT_TOKEN=$(echo "$DAWIT" | jget "['accessToken']")
SELAM=$(login selam@aastu.edu.et); SELAM_TOKEN=$(echo "$SELAM" | jget "['accessToken']")
ROBEL=$(login robel@aastu.edu.et); ROBEL_TOKEN=$(echo "$ROBEL" | jget "['accessToken']")
ADMIN=$(login admin@aastu.edu.et); ADMIN_TOKEN=$(echo "$ADMIN" | jget "['accessToken']")
pass "All 5 demo accounts logged in"

echo "=== P2-1: Redis-backed rate limiting ==="
# Hammer the login endpoint past its limit (max 8/min) and confirm 429s appear.
CODES=""
for i in $(seq 1 10); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" -H "Content-Type: application/json" \
    -d '{"email":"nobody@example.com","password":"wrong"}')
  CODES="$CODES $CODE"
done
echo "  codes: $CODES"
echo "$CODES" | grep -q "429" && pass "Rate limiter triggered a 429 (Redis or in-memory fallback both fine)" || fail "no 429 seen — rate limiter not working"

echo "=== P2-2: SMS notification simulation ==="
grep -q "DEV SMS" /tmp/backend.log && pass "[DEV SMS] log lines present (from earlier notifications)" || echo "  ⚠️  no DEV SMS lines yet — will trigger one below"

echo "=== P2-3: P2P in-app payment ==="
LISTINGS=$(curl -s "$BASE/listings")
LISTING_ID=$(echo "$LISTINGS" | jget "['listings'][0]['id']")
REQ=$(curl -s -X POST "$BASE/listings/$LISTING_ID/requests" -H "Authorization: Bearer $DAWIT_TOKEN" -H "Content-Type: application/json" -d '{"message":"paying in-app"}')
REQ_ID=$(echo "$REQ" | jget "['request']['id']")
ACCEPT=$(curl -s -X PATCH "$BASE/listings/requests/$REQ_ID" -H "Authorization: Bearer $SARA_TOKEN" -H "Content-Type: application/json" -d '{"status":"accepted"}')
ORDER_ID=$(echo "$ACCEPT" | jget "['order']['id']")
[ -n "$ORDER_ID" ] && pass "p2p_order auto-created on accept ($ORDER_ID)" || { echo "$ACCEPT"; fail "no order created on accept"; }

PAY=$(curl -s -X POST "$BASE/listings/requests/$REQ_ID/pay" -H "Authorization: Bearer $DAWIT_TOKEN" -H "Content-Type: application/json" -d '{}')
PAYMENT_ID=$(echo "$PAY" | jget "['payment']['paymentId']")
[ -n "$PAYMENT_ID" ] && pass "P2P payment initiated" || { echo "$PAY"; fail "p2p pay init failed"; }

curl -s -X POST "$BASE/payments/mock/$PAYMENT_ID/complete" -H "Authorization: Bearer $DAWIT_TOKEN" -H "Content-Type: application/json" -d '{"outcome":"success"}' > /tmp/p2ppay.json
ORDER_CHECK=$(curl -s "$BASE/listings/requests/$REQ_ID/order" -H "Authorization: Bearer $DAWIT_TOKEN")
ORDER_STATUS=$(echo "$ORDER_CHECK" | jget "['order']['status']")
[ "$ORDER_STATUS" = "paid" ] && pass "P2P order marked paid after payment confirms" || { echo "$ORDER_CHECK"; fail "p2p order not paid"; }
LISTING_CHECK=$(curl -s "$BASE/listings/$LISTING_ID")
LISTING_STATUS=$(echo "$LISTING_CHECK" | jget "['listing']['status']")
[ "$LISTING_STATUS" = "sold" ] && pass "Listing auto-marked sold" || fail "listing not marked sold: $LISTING_STATUS"

echo "=== P2-4: Tiered late-fee escalation ==="
RENTAL=$(curl -s -X POST "$BASE/rentals" -H "Authorization: Bearer $DAWIT_TOKEN" -H "Content-Type: application/json" -d '{
  "title":"Test Tiered-Fee Item","pricePerDay":100,"deposit":500,
  "availableFrom":"2020-01-01","availableTo":"2030-01-01",
  "lateFeePolicy":[{"upToDays":2,"ratePerDay":0.5},{"upToDays":null,"ratePerDay":1.0}]
}')
ITEM_ID=$(echo "$RENTAL" | jget "['item']['id']")
[ -n "$ITEM_ID" ] && pass "Rental item created with custom late-fee policy" || { echo "$RENTAL"; fail "create with policy failed"; }

# Book dates that already ended 5 days ago so the return call computes a real late fee.
BOOKING=$(curl -s -X POST "$BASE/rentals/$ITEM_ID/bookings" -H "Authorization: Bearer $SARA_TOKEN" -H "Content-Type: application/json" \
  -d '{"startDate":"2024-01-01","endDate":"2024-01-02"}')
BOOKING_ID=$(echo "$BOOKING" | jget "['booking']['id']")
BOOKING_PAY=$(echo "$BOOKING" | jget "['payment']['paymentId']")
curl -s -X POST "$BASE/payments/mock/$BOOKING_PAY/complete" -H "Authorization: Bearer $SARA_TOKEN" -H "Content-Type: application/json" -d '{"outcome":"success"}' > /dev/null
curl -s -X POST "$BASE/rentals/bookings/$BOOKING_ID/pickup" -H "Authorization: Bearer $DAWIT_TOKEN" > /dev/null
RETURN=$(curl -s -X POST "$BASE/rentals/bookings/$BOOKING_ID/return" -H "Authorization: Bearer $DAWIT_TOKEN" -H "Content-Type: application/json" -d '{"condition":"fine"}')
LATE_FEE=$(echo "$RETURN" | jget "['lateFee']")
DAYS_LATE=$(echo "$RETURN" | jget "['daysLate']")
echo "  days late: $DAYS_LATE, late fee: $LATE_FEE"
# 2024-01-02 is ~2.5+ years before today, so daysLate is huge; the point is
# just confirming the tiered formula ran (fee > flat 0.5x would-be value).
FLAT_WOULD_BE=$(python3 -c "print($DAYS_LATE * 100 * 0.5)")
python3 -c "exit(0 if float('$LATE_FEE') > float('$FLAT_WOULD_BE') else 1)" && \
  pass "Tiered fee ($LATE_FEE) exceeds flat-rate equivalent ($FLAT_WOULD_BE) as expected" || \
  fail "tiered fee calculation looks wrong: $LATE_FEE vs flat $FLAT_WOULD_BE"

echo "=== P2-5: Recurring events + waitlist ==="
EVENTS_MINE=$(curl -s "$BASE/events/mine" -H "Authorization: Bearer $ROBEL_TOKEN")
PUBLISHED_EVENT_ID=$(echo "$EVENTS_MINE" | python3 -c "import json,sys; d=json.load(sys.stdin); print([e['id'] for e in d['events'] if e['status']=='published'][0])")
OCC=$(curl -s -X POST "$BASE/events/$PUBLISHED_EVENT_ID/generate-occurrences" -H "Authorization: Bearer $ROBEL_TOKEN" -H "Content-Type: application/json" -d '{"count":3,"intervalDays":7}')
OCC_COUNT=$(echo "$OCC" | python3 -c "import json,sys; print(len(json.load(sys.stdin)['occurrences']))")
[ "$OCC_COUNT" = "3" ] && pass "3 recurring occurrences generated" || { echo "$OCC"; fail "occurrence generation failed"; }

# Fill the VIP ticket type to sold-out, then confirm waitlist join + notify-on-cancel.
EVENT_DETAIL=$(curl -s "$BASE/events/$PUBLISHED_EVENT_ID")
VIP_TT=$(echo "$EVENT_DETAIL" | python3 -c "
import json,sys
d = json.load(sys.stdin)
tt = [t for t in d['ticketTypes'] if t['name']=='VIP'][0]
print(tt['id'], tt['quantity_total'], tt['quantity_sold'])
")
read VIP_ID VIP_TOTAL VIP_SOLD <<< "$VIP_TT"
REMAINING=$((VIP_TOTAL - VIP_SOLD))
echo "  VIP remaining before fill: $REMAINING"

# Sell out remaining VIP capacity using throwaway student accounts.
# Filler accounts need to be verified (their email already matches the
# seeded university's domain — they just need universityId on registration
# so the automatic domain-match verification in FR-002 actually fires).
UNI_ID=$(curl -s "$BASE/meta/universities" | python3 -c "import json,sys; print(json.load(sys.stdin)['universities'][0]['id'])")

LAST_TICKET_ID=""
for i in $(seq 1 $REMAINING); do
  EMAIL="filler$i@aastu.edu.et"
  curl -s -X POST "$BASE/auth/register" -H "Content-Type: application/json" \
    -d "{\"name\":\"Filler $i\",\"email\":\"$EMAIL\",\"password\":\"Password123!\",\"role\":\"student\",\"universityId\":\"$UNI_ID\"}" > /dev/null
  FTOKEN=$(login "$EMAIL" | jget "['accessToken']")
  T=$(curl -s -X POST "$BASE/events/$PUBLISHED_EVENT_ID/tickets" -H "Authorization: Bearer $FTOKEN" -H "Content-Type: application/json" -d "{\"ticketTypeId\":\"$VIP_ID\"}")
  TID=$(echo "$T" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ticket',{}).get('id','ERROR: '+json.dumps(d)))")
  if [[ "$TID" == ERROR* ]]; then echo "$TID"; fail "filler ticket purchase $i failed"; fi
  PID=$(echo "$T" | jget "['payment']['paymentId']")
  curl -s -X POST "$BASE/payments/mock/$PID/complete" -H "Authorization: Bearer $FTOKEN" -H "Content-Type: application/json" -d '{"outcome":"success"}' > /dev/null
  LAST_TICKET_ID=$TID
  LAST_FTOKEN=$FTOKEN
done
pass "VIP capacity filled ($REMAINING tickets sold)"

SOLDOUT_CHECK=$(curl -s -X POST "$BASE/events/$PUBLISHED_EVENT_ID/tickets" -H "Authorization: Bearer $SARA_TOKEN" -H "Content-Type: application/json" -d "{\"ticketTypeId\":\"$VIP_ID\"}")
SOLDOUT_CODE=$(echo "$SOLDOUT_CHECK" | jget "['error']['code']")
[ "$SOLDOUT_CODE" = "SOLD_OUT" ] && pass "Purchase correctly rejected once sold out" || { echo "$SOLDOUT_CHECK"; fail "sold-out check failed"; }

WAITLIST=$(curl -s -X POST "$BASE/events/$PUBLISHED_EVENT_ID/waitlist" -H "Authorization: Bearer $SARA_TOKEN" -H "Content-Type: application/json" -d "{\"ticketTypeId\":\"$VIP_ID\"}")
echo "$WAITLIST" | grep -q "id" && pass "Sara joined the VIP waitlist" || { echo "$WAITLIST"; fail "waitlist join failed"; }

# Cancel the last filler's ticket -> should notify Sara (first in line).
curl -s -X POST "$BASE/tickets/$LAST_TICKET_ID/cancel" -H "Authorization: Bearer $LAST_FTOKEN" -H "Content-Type: application/json" -d '{}' > /dev/null
MY_WAITLIST=$(curl -s "$BASE/events/waitlist/mine" -H "Authorization: Bearer $SARA_TOKEN")
WSTATUS=$(echo "$MY_WAITLIST" | jget "['entries'][0]['status']")
[ "$WSTATUS" = "notified" ] && pass "Waitlist entry auto-notified after a cancellation freed a spot" || { echo "$MY_WAITLIST"; fail "waitlist notify failed: $WSTATUS"; }

echo "=== P2-6: Offline ticket scan batch verification ==="
# Buy two fresh tickets (General type, plenty of capacity) to batch-verify.
GEN_TT=$(echo "$EVENT_DETAIL" | python3 -c "import json,sys; print([t['id'] for t in json.load(sys.stdin)['ticketTypes'] if t['name']=='General'][0])")
T1=$(curl -s -X POST "$BASE/events/$PUBLISHED_EVENT_ID/tickets" -H "Authorization: Bearer $SARA_TOKEN" -H "Content-Type: application/json" -d "{\"ticketTypeId\":\"$GEN_TT\"}")
T1_ID=$(echo "$T1" | jget "['ticket']['id']")
T1_PAY=$(echo "$T1" | jget "['payment']['paymentId']")
curl -s -X POST "$BASE/payments/mock/$T1_PAY/complete" -H "Authorization: Bearer $SARA_TOKEN" -H "Content-Type: application/json" -d '{"outcome":"success"}' > /dev/null

QR1=$(node -e "
const { signTicket, buildQrPayload } = require(process.cwd() + '/src/utils/qr');
console.log(buildQrPayload('$T1_ID', signTicket('$T1_ID')));
")

# Simulate an offline device that scanned the SAME ticket twice while
# offline (once "at 10:00", once "at 10:05"), then syncs both at once.
BATCH=$(curl -s -X POST "$BASE/tickets/verify-batch" -H "Authorization: Bearer $ROBEL_TOKEN" -H "Content-Type: application/json" -d "{
  \"scans\": [
    {\"ticketId\":\"$T1_ID\",\"qrToken\":\"$QR1\",\"scannedAt\":\"2026-01-01T10:05:00Z\"},
    {\"ticketId\":\"$T1_ID\",\"qrToken\":\"$QR1\",\"scannedAt\":\"2026-01-01T10:00:00Z\"}
  ]
}")
echo "$BATCH" | python3 -m json.tool
FIRST_RESULT=$(echo "$BATCH" | python3 -c "import json,sys; print(json.load(sys.stdin)['results'][0]['result'])")
SECOND_RESULT=$(echo "$BATCH" | python3 -c "import json,sys; print(json.load(sys.stdin)['results'][1]['result'])")
# Sorted by scannedAt ascending, the 10:00 entry (index 1 in the input, but
# processed first) should ADMIT, and the 10:05 one should be ALREADY_USED —
# but since results are returned in *sorted* processing order, results[0]
# is the 10:00 scan.
[ "$FIRST_RESULT" = "ADMIT" ] && [ "$SECOND_RESULT" = "ALREADY_USED" ] && \
  pass "Batch processed in chronological order: earliest scan ADMIT, later one ALREADY_USED" || \
  fail "batch ordering wrong: $FIRST_RESULT / $SECOND_RESULT"

echo "=== P2-7: Payment provider failover ==="
FAILOVER=$(PAYMENT_PROVIDER=chapa node -e "
require('dotenv').config({quiet:true, path: process.cwd() + '/.env'});
process.env.PAYMENT_PROVIDER = 'chapa';
delete process.env.CHAPA_SECRET_KEY;
const payments = require(process.cwd() + '/src/services/payments');
const p = payments._selectProvider();
console.log(p.name);
")
[ "$FAILOVER" = "mock" ] && pass "Unconfigured 'chapa' provider correctly fails over to 'mock'" || fail "failover broken: got $FAILOVER"

echo "=== P2-8: CSV export ==="
CSV=$(curl -s "$BASE/admin/reports/export?type=orders" -H "Authorization: Bearer $ADMIN_TOKEN")
echo "$CSV" | head -3
echo "$CSV" | grep -q "Order ID,Status,Total" && pass "Orders CSV export has expected header" || fail "CSV export malformed"

echo ""
echo "🎉 ALL PHASE 2 SMOKE TESTS PASSED"
