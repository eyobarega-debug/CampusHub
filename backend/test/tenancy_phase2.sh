#!/bin/bash
# Phase 2 x Phase 3 merge test. Run against a FRESH database (db:migrate:all +
# db:seed) and a running server, from the backend folder with .env exported:
#   set -a; source .env; set +a; bash test/tenancy_phase2.sh      (npm run test:tenancy:phase2)
# Proves the Phase 2 features (event cache, waitlist, recurring events, CSV
# exports, in-app P2P payments) stay inside one university once a second
# university exists.
BASE="http://localhost:4000/api"
PASS="Password123!"
FAILS=0
ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1  (got: $2)"; FAILS=$((FAILS+1)); }
call() {
  local args=(-s -o /tmp/ten2_body -w "%{http_code}" -X "$1" "$BASE$2" -H "Content-Type: application/json")
  [ -n "$3" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "$5" ] && args+=(-H "$5")
  [ -n "$4" ] && args+=(-d "$4")
  STATUS=$(curl "${args[@]}"); BODY=$(cat /tmp/ten2_body)
}
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" <<<"$BODY"; }
expect() { if [ "$STATUS" == "$2" ]; then ok "$1"; else bad "$1 (expected $2)" "$STATUS $BODY"; fi; }
login() { call POST /auth/login "" "{\"email\":\"$1\",\"password\":\"$PASS\"}"; j "d['accessToken']"; }

echo "=== Setup: second university (Bahir Dar) next to AASTU ==="
SUPER=$(login super@campushub.et); AASTU_ADMIN=$(login admin@aastu.edu.et)
SARA=$(login sara@aastu.edu.et); DAWIT=$(login dawit@aastu.edu.et); ROBEL=$(login robel@aastu.edu.et)
call GET /meta/universities; AASTU_ID=$(j "d['universities'][0]['id']")
call POST /super/universities "$SUPER" '{"name":"Bahir Dar University","domain":"bdu.edu.et","admin":{"name":"Admin Meseret","email":"admin@bdu.edu.et","password":"Password123!"},"initialClubs":["BDU Robotics Club"]}'
expect "onboard Bahir Dar University" 201
BDU_ID=$(j "d['university']['id']")
call POST /auth/register "" '{"name":"Hana","email":"hana@bdu.edu.et","password":"Password123!"}'
expect "register BDU student" 201
HANA=$(login hana@bdu.edu.et); BDU_ADMIN=$(login admin@bdu.edu.et)

echo "=== Event-list cache never crosses campuses ==="
call GET "/events?universityId=$AASTU_ID"; N1=$(j "len(d['events'])")
call GET "/events?universityId=$AASTU_ID"; N2=$(j "len(d['events'])")   # second hit comes from the cache
[ "$N1" -gt 0 ] && [ "$N1" == "$N2" ] && ok "AASTU sees its $N1 events (cached on 2nd call)" || bad "AASTU events" "$N1 / $N2"
call GET "/events?universityId=$BDU_ID"
[ "$(j "len(d['events'])")" == "0" ] && ok "BDU gets none of AASTU's cached events" || bad "cache leaked across tenants" "$BODY"
EVENT_ID=$(curl -s "$BASE/events?universityId=$AASTU_ID" | python3 -c "import json,sys; print([e['id'] for e in json.load(sys.stdin)['events']][0])")
VIP_ID=$(curl -s "$BASE/events/$EVENT_ID?universityId=$AASTU_ID" | python3 -c "import json,sys; print([t['id'] for t in json.load(sys.stdin)['ticketTypes'] if t['name']=='VIP'][0])")

echo "=== Waitlist is tenant-bound ==="
call POST "/events/$EVENT_ID/waitlist" "$HANA" "{\"ticketTypeId\":\"$VIP_ID\"}"
expect "BDU student cannot join an AASTU event's waitlist (404)" 404

echo "=== Recurring events are tenant-bound ==="
call POST "/events/$EVENT_ID/generate-occurrences" "$ROBEL" '{"count":2,"intervalDays":7}'
expect "AASTU organizer generates occurrences" 201
call GET "/events/$EVENT_ID/occurrences?universityId=$AASTU_ID"
[ "$(j "len(d['occurrences'])")" == "2" ] && ok "AASTU sees its 2 occurrences" || bad "AASTU occurrences" "$BODY"
call GET "/events/$EVENT_ID/occurrences?universityId=$BDU_ID"
[ "$(j "len(d['occurrences'])")" == "0" ] && ok "BDU sees none of them" || bad "occurrence leak" "$BODY"

echo "=== In-app P2P payment keeps its university ==="
call GET "/listings?universityId=$AASTU_ID"; LISTING_ID=$(j "d['listings'][0]['id']")
call POST "/listings/$LISTING_ID/requests" "$HANA" '{"message":"cross-campus attempt"}'
expect "BDU student cannot request an AASTU listing (404)" 404
call POST "/listings/$LISTING_ID/requests" "$DAWIT" '{"message":"paying in-app"}'; REQ_ID=$(j "d['request']['id']")
call PATCH "/listings/requests/$REQ_ID" "$SARA" '{"status":"accepted"}'; expect "seller accepts -> p2p order" 200
call POST "/listings/requests/$REQ_ID/pay" "$DAWIT" '{}'; PAYMENT_ID=$(j "d['payment']['paymentId']")
call POST "/payments/mock/$PAYMENT_ID/complete" "$DAWIT" '{"outcome":"success"}'; expect "P2P payment confirmed" 200
if command -v psql >/dev/null 2>&1 && [ -n "$DATABASE_URL" ]; then
  Q1=$(psql "$DATABASE_URL" -Atc "SELECT university_id FROM p2p_orders WHERE request_id='$REQ_ID'")
  Q2=$(psql "$DATABASE_URL" -Atc "SELECT university_id FROM payments WHERE id='$PAYMENT_ID'")
  [ "$Q1" == "$AASTU_ID" ] && ok "p2p_orders row stamped with AASTU's university_id" || bad "p2p_orders tenant" "$Q1"
  [ "$Q2" == "$AASTU_ID" ] && ok "p2p_order payment stamped with AASTU's university_id" || bad "payment tenant" "$Q2"
else
  echo "  (skipped DB tenant-stamp checks: psql / DATABASE_URL not available)"
fi

echo "=== CSV exports are scoped to the caller's university ==="
call GET "/admin/reports/export?type=users" "$BDU_ADMIN"; expect "BDU admin exports users" 200
echo "$BODY" | grep -q "hana@bdu.edu.et" && ! echo "$BODY" | grep -q "aastu.edu.et" && ok "BDU users CSV: BDU only" || bad "users CSV leak" "$BODY"
call GET "/admin/reports/export?type=users" "$AASTU_ADMIN"
echo "$BODY" | grep -q "sara@aastu.edu.et" && ! echo "$BODY" | grep -q "bdu.edu.et" && ok "AASTU users CSV: AASTU only" || bad "users CSV leak" "$BODY"
call GET "/admin/reports/export?type=transactions" "$BDU_ADMIN"
[ "$(echo "$BODY" | grep -c .)" == "1" ] && ok "BDU transactions CSV has no AASTU rows (header only)" || bad "transactions CSV leak" "$BODY"
call GET "/admin/reports/export?type=transactions" "$AASTU_ADMIN"
[ "$(echo "$BODY" | grep -c .)" -gt 1 ] && ok "AASTU transactions CSV has its P2P charge" || bad "AASTU transactions empty" "$BODY"
call GET "/admin/reports/export?type=orders" "$BDU_ADMIN"
! echo "$BODY" | grep -q "sara@aastu.edu.et\|selam@aastu.edu.et" && ok "BDU orders CSV has no AASTU buyers" || bad "orders CSV leak" "$BODY"

echo "=== Merchant order export is tenant-bound ==="
call GET "/products?universityId=$AASTU_ID"; PRODUCT_ID=$(j "d['products'][0]['id']")
call GET "/products/$PRODUCT_ID?universityId=$AASTU_ID"; STORE_ID=$(j "d['product']['store_id']")
call GET "/merchants/$STORE_ID/orders/export" "$BDU_ADMIN"; expect "BDU admin cannot export an AASTU store's orders (404)" 404
call GET "/merchants/$STORE_ID/orders/export" "$AASTU_ADMIN"; expect "AASTU admin can export its store's orders" 200

echo ""
if [ "$FAILS" == "0" ]; then echo "🎉 ALL PHASE 2 x PHASE 3 TENANCY CHECKS PASSED"; else echo "❌ $FAILS CHECK(S) FAILED"; exit 1; fi
