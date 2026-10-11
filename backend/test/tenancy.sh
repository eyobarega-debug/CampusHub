#!/bin/bash
# Phase 3 multi-tenancy test. Run against a FRESH database (schema + phase 3
# migration + seed) and a running server:  npm run test:tenancy
# Proves tenant isolation, Super Admin onboarding, feature flags and fee schedules.
BASE="http://localhost:4000/api"
PASS="Password123!"
FAILS=0
ok()   { echo "  ✅ $1"; }
bad()  { echo "  ❌ $1  (got: $2)"; FAILS=$((FAILS+1)); }
# call METHOD PATH TOKEN [JSON] [extra header]  -> sets $STATUS and $BODY
call() {
  local args=(-s -o /tmp/ten_body -w "%{http_code}" -X "$1" "$BASE$2" -H "Content-Type: application/json")
  [ -n "$3" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "$5" ] && args+=(-H "$5")
  [ -n "$4" ] && args+=(-d "$4")
  STATUS=$(curl "${args[@]}"); BODY=$(cat /tmp/ten_body)
}
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" <<<"$BODY"; }
expect() { # expect "label" status
  if [ "$STATUS" == "$2" ]; then ok "$1"; else bad "$1 (expected $2)" "$STATUS $BODY"; fi; }
login() { call POST /auth/login "" "{\"email\":\"$1\",\"password\":\"$PASS\"}"; j "d['accessToken']"; }

echo "=== Setup: log in ==="
SUPER=$(login super@campushub.et); AASTU_ADMIN=$(login admin@aastu.edu.et); SARA=$(login sara@aastu.edu.et); SELAM=$(login selam@aastu.edu.et)
[ -n "$SUPER" ] && [ -n "$AASTU_ADMIN" ] && ok "super admin + AASTU accounts log in" || bad "login" "-"
call GET /meta/universities; AASTU_ID=$(j "d['universities'][0]['id']")
call GET /products; PRODUCT_ID=$(j "d['products'][0]['id']")

echo "=== Super Admin: access control ==="
call GET /super/universities "$AASTU_ADMIN"; expect "university admin cannot reach /super" 403
call GET /super/universities "$SARA";        expect "student cannot reach /super" 403
call GET /super/universities "";             expect "anonymous cannot reach /super" 401
call GET /super/universities "$SUPER";       expect "super admin lists universities" 200

echo "=== Single-campus compatibility (before 2nd university) ==="
call GET /products; expect "anonymous browse works with one university" 200

echo "=== University onboarding ==="
call POST /super/universities "$SUPER" '{"name":"Bahir Dar University","domain":"bdu.edu.et","admin":{"name":"Admin Meseret","email":"admin@bdu.edu.et","password":"Password123!"},"initialClubs":["BDU Robotics Club"]}'
expect "onboard Bahir Dar University (+admin +club)" 201
BDU_ID=$(j "d['university']['id']")
call POST /super/universities "$SUPER" '{"name":"BDU Again","domain":"bdu.edu.et","admin":{"name":"X Y","email":"x@other.edu","password":"Password123!"}}'
expect "duplicate domain rejected" 409
call PATCH "/super/universities/$BDU_ID" "$SUPER" '{"isolationMode":"dedicated"}'
expect "dedicated isolation requires a reason" 400

echo "=== Registration is tenant-bound ==="
call POST /auth/register "" '{"name":"Hana","email":"hana@bdu.edu.et","password":"Password123!"}'
expect "register by email domain -> BDU" 201
[ "$(j "d['user']['university_id']")" == "$BDU_ID" ] && [ "$(j "d['user']['verified']")" == "True" ] && ok "auto-assigned to BDU and auto-verified" || bad "domain assignment" "$BODY"
call POST /auth/register "" '{"name":"Nobody","email":"nobody@gmail.com","password":"Password123!"}'
expect "unknown domain without universityId rejected" 400
call POST /auth/register "" '{"name":"Role Hack","email":"hack@bdu.edu.et","password":"Password123!","role":"admin"}'
expect "cannot self-register as admin" 400
HANA=$(login hana@bdu.edu.et); BDU_ADMIN=$(login admin@bdu.edu.et)

echo "=== Anonymous browsing needs a tenant once there are 2 universities ==="
call GET /products;                              expect "no tenant -> 400" 400
call GET "/products?universityId=$AASTU_ID";     expect "AASTU tenant -> 200" 200
N=$(j "len(d['products'])"); [ "$N" -gt 0 ] && ok "AASTU sees its $N products" || bad "AASTU products" "$BODY"
call GET "/products?universityId=$BDU_ID";       expect "BDU tenant -> 200" 200
[ "$(j "len(d['products'])")" == "0" ] && ok "BDU sees none of AASTU's products" || bad "BDU leaked products" "$BODY"

echo "=== Cross-tenant access is blocked ==="
call GET "/products/$PRODUCT_ID" "$HANA";        expect "BDU student cannot read AASTU product by id (404)" 404
call POST /orders "$HANA" "{\"items\":[{\"productId\":\"$PRODUCT_ID\",\"quantity\":1}]}"
expect "BDU student cannot order AASTU product" 404
call GET /products "$HANA" "" "X-University-Id: $AASTU_ID"
expect "tenant header spoof rejected" 403
call GET /products "$HANA";                      [ "$(j "len(d['products'])")" == "0" ] && ok "BDU student browse is BDU-only" || bad "BDU browse" "$BODY"

echo "=== Admin isolation ==="
call GET /admin/users "$BDU_ADMIN"; expect "BDU admin lists users" 200
j "all(u['university_id']=='$BDU_ID' for u in d['users'])" | grep -q True && ok "BDU admin sees only BDU users" || bad "user list leak" "$BODY"
call GET /admin/users "$AASTU_ADMIN"
j "all(u['university_id']=='$AASTU_ID' for u in d['users'])" | grep -q True && ok "AASTU admin sees only AASTU users" || bad "user list leak" "$BODY"
HANA_ID=$(curl -s "$BASE/admin/users" -H "Authorization: Bearer $BDU_ADMIN" | python3 -c "import json,sys;print([u['id'] for u in json.load(sys.stdin)['users'] if u['email']=='hana@bdu.edu.et'][0])")
call PATCH "/admin/users/$HANA_ID" "$AASTU_ADMIN" '{"suspended":true}'
expect "AASTU admin cannot suspend a BDU user" 404
call POST /admin/clubs "$AASTU_ADMIN" "{\"name\":\"Sneaky\",\"leadUserId\":\"$HANA_ID\"}"
expect "AASTU admin cannot make a BDU user a club lead" 404
call POST /merchants/apply "$HANA" '{"businessName":"Hana Snacks"}'; expect "BDU student applies as merchant" 201
call GET "/merchants/applications" "$AASTU_ADMIN"
[ "$(j "len(d['applications'])")" == "0" ] && ok "AASTU admin can't see BDU's application" || bad "application leak" "$BODY"
call GET "/merchants/applications" "$BDU_ADMIN"
APP_ID=$(j "d['applications'][0]['id']")
call PATCH "/merchants/$APP_ID/decision" "$AASTU_ADMIN" '{"decision":"approve"}'
expect "AASTU admin cannot decide BDU's application" 404
call PATCH "/merchants/$APP_ID/decision" "$BDU_ADMIN" '{"decision":"approve"}'
expect "BDU admin decides its own application" 200
call GET /admin/analytics "$BDU_ADMIN"
[ "$(j "d['storeCount']")" == "1" ] && ok "BDU analytics scoped (1 store)" || bad "BDU analytics" "$BODY"

echo "=== Super admin acts inside a tenant / across tenants ==="
call GET /admin/users "$SUPER" "" "X-University-Id: $BDU_ID"
j "all(u['university_id']=='$BDU_ID' for u in d['users'])" | grep -q True && ok "super admin + header = single tenant view" || bad "super scoped" "$BODY"
call GET /admin/users "$SUPER"
[ "$(j "len({u['university_id'] for u in d['users']})")" -ge 2 ] && ok "super admin without header = all tenants" || bad "super cross" "$BODY"
call GET /super/analytics/compare "$SUPER"; expect "cross-university analytics" 200
[ "$(j "len(d['universities'])")" == "2" ] && ok "compare returns both universities" || bad "compare" "$BODY"

echo "=== Feature flags ==="
call GET /rentals "$HANA"; expect "BDU rentals enabled by default" 200
call PATCH "/super/universities/$BDU_ID" "$SUPER" '{"featureFlags":{"rentals":false}}'; expect "super admin disables rentals for BDU" 200
call GET /rentals "$HANA"; expect "BDU rentals now blocked" 403
[ "$(j "d['error']['code']")" == "FEATURE_DISABLED" ] && ok "error code FEATURE_DISABLED" || bad "code" "$BODY"
call GET /rentals "$SARA"; expect "AASTU rentals unaffected" 200

echo "=== Fee schedules ==="
call POST /super/fee-schedules "$SUPER" "{\"universityId\":\"$BDU_ID\",\"commissionRate\":0.10,\"featuredRatePerDay\":35}"; expect "BDU fee schedule created" 201
call POST /super/fee-schedules "$SUPER" "{\"universityId\":\"$BDU_ID\",\"commissionRate\":0.9,\"featuredRatePerDay\":35}"; expect "absurd commission rejected" 400
RES=$(node -e "
const {getFees}=require('./src/services/fees');
Promise.all([getFees('$BDU_ID'),getFees('$AASTU_ID')]).then(([b,a])=>{console.log(b.commissionRate,b.featuredRatePerDay,a.commissionRate,a.featuredRatePerDay);process.exit(0)})")
[ "$RES" == "0.1 35 0.05 20" ] && ok "BDU gets 10%/35, AASTU falls back to platform default 5%/20" || bad "fees" "$RES"

echo "=== Admin lifecycle ==="
call POST /super/admins/demote "$SUPER" "{\"userId\":\"$(curl -s $BASE/super/admins -H "Authorization: Bearer $SUPER" | python3 -c "import json,sys;print([a['id'] for a in json.load(sys.stdin)['admins'] if a['email']=='admin@bdu.edu.et'][0])")\"}"
expect "cannot demote a university's last admin" 409
call PATCH "/admin/users/$HANA_ID" "$BDU_ADMIN" '{"role":"admin"}'; expect "university admin cannot mint admins" 400
call POST /super/admins/promote "$SUPER" "{\"userId\":\"$HANA_ID\"}"; expect "super admin promotes a BDU user to admin" 200

echo
[ $FAILS -eq 0 ] && echo "ALL TENANCY CHECKS PASSED" || { echo "$FAILS CHECK(S) FAILED"; exit 1; }
