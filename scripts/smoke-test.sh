#!/usr/bin/env bash
# End-to-end walk through the Modules 1-3 foundation against a running
# `npm run dev`. Exercises the happy path AND the zero-trust guards -- a guard
# that is never tested is a guard nobody knows is broken.
#
#   npm run dev          # in one terminal
#   bash scripts/smoke-test.sh
set -u

BASE="${BASE:-http://127.0.0.1:8787}"
PASS=0
FAIL=0

# The expression travels in $EXPR rather than being spliced into the JS source,
# so it may contain quotes without fighting two levels of shell escaping.
j() { EXPR="$1" node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const v=eval(process.env.EXPR);console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('')}})"; }

check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1));
  else printf '  \033[31mFAIL\033[0m %s (got %s, want %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}

post() { curl -s -o /tmp/body -w '%{http_code}' -X "$1" "$BASE$2" -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} ${4:+-d "$4"}; }
get()  { curl -s -o /tmp/body -w '%{http_code}' "$BASE$1" ${2:+-H "Authorization: Bearer $2"}; }

echo "== 1. Bootstrap the first Super Admin =="
CODE=$(post POST /api/bootstrap/super-admin "" '{"email":"admin@teacheasy.ng","password":"SuperSecret123!","firstName":"Ada","lastName":"Okoro"}')
check "bootstrap creates the Super Admin" "$CODE" "201"

CODE=$(post POST /api/bootstrap/super-admin "" '{"email":"attacker@evil.ng","password":"SuperSecret123!","firstName":"Mal","lastName":"Ory"}')
check "bootstrap is closed once a Super Admin exists" "$CODE" "403"

echo "== 2. Login =="
post POST /api/auth/login "" '{"email":"admin@teacheasy.ng","password":"SuperSecret123!"}' >/dev/null
ADMIN=$(j 'o.data.tokens.accessToken' < /tmp/body)
[ -n "$ADMIN" ] && check "super admin receives a bearer token" "ok" "ok" || check "super admin receives a bearer token" "no-token" "ok"

CODE=$(post POST /api/auth/login "" '{"email":"admin@teacheasy.ng","password":"wrong-password"}')
check "wrong password is rejected" "$CODE" "401"

get /api/me "$ADMIN" >/dev/null
check "dashboard routes to /admin" "$(j 'o.data.dashboard.home' < /tmp/body)" "/admin"
check "super admin holds every non-self permission" "$(j 'o.data.permissions.length' < /tmp/body)" "37"

echo "== 3. Unauthenticated access is denied by default =="
check "admin users list needs a session" "$(get /api/admin/users)" "401"
check "partners list needs a session"    "$(get /api/partners)" "401"
check "agreements list needs a session"  "$(get /api/agreements)" "401"

echo "== 4. Create three partners =="
for spec in "PTR-A:Adaeze Ventures Ltd:partner.a@teacheasy.ng" \
            "PTR-B:Bello Holdings:partner.b@teacheasy.ng" \
            "PTR-C:Chidi Educational Services:partner.c@teacheasy.ng"; do
  CODE_P=${spec%%:*}; REST=${spec#*:}; NAME=${REST%%:*}; MAIL=${REST#*:}
  post POST /api/partners "$ADMIN" "{\"code\":\"$CODE_P\",\"legalName\":\"$NAME\",\"email\":\"$MAIL\",\"partnerType\":\"COMPANY\"}" >/dev/null
  eval "P_${CODE_P#PTR-}=$(j 'o.data.id' < /tmp/body)"
done
check "three partners created" "$([ -n "$P_A" ] && [ -n "$P_B" ] && [ -n "$P_C" ] && echo ok)" "ok"

echo "== 5. Partnership group =="
post POST /api/partnership-groups "$ADMIN" '{"code":"TEACHEASY","name":"TeachEasy Founding Partners"}' >/dev/null
GROUP=$(j 'o.data.id' < /tmp/body)
for P in "$P_A" "$P_B" "$P_C"; do
  post POST "/api/partnership-groups/$GROUP/members" "$ADMIN" "{\"partnerId\":\"$P\"}" >/dev/null
done
get "/api/partnership-groups/$GROUP/members" "$ADMIN" >/dev/null
check "group has three members" "$(j 'o.data.length' < /tmp/body)" "3"

echo "== 6. Draft the 40/35/25 formula =="
post POST /api/agreements "$ADMIN" "{\"groupId\":\"$GROUP\",\"title\":\"Founding revenue share\",\"basis\":\"NET\",\"effectiveFrom\":\"2026-09-01\"}" >/dev/null
AGR=$(j 'o.data.id' < /tmp/body)
check "agreement drafted as v1" "$(j 'o.data.version' < /tmp/body)" "1"

# A formula that does not total 100% must be reported as invalid.
post PUT "/api/agreements/$AGR/lines" "$ADMIN" "{\"lines\":[
  {\"partnerId\":\"$P_A\",\"shareType\":\"PERCENTAGE\",\"shareBps\":4000},
  {\"partnerId\":\"$P_B\",\"shareType\":\"PERCENTAGE\",\"shareBps\":3000}]}" >/dev/null
check "a 70% formula is flagged invalid" "$(j 'o.data.valid' < /tmp/body)" "false"

CODE=$(post POST "/api/agreements/$AGR/propose" "$ADMIN" '{}')
check "an invalid formula cannot be proposed" "$CODE" "422"

post PUT "/api/agreements/$AGR/lines" "$ADMIN" "{\"lines\":[
  {\"partnerId\":\"$P_A\",\"shareType\":\"PERCENTAGE\",\"shareBps\":4000},
  {\"partnerId\":\"$P_B\",\"shareType\":\"PERCENTAGE\",\"shareBps\":3500},
  {\"partnerId\":\"$P_C\",\"shareType\":\"PERCENTAGE\",\"shareBps\":2500}]}" >/dev/null
check "the 40/35/25 formula is valid" "$(j 'o.data.valid' < /tmp/body)" "true"

echo "== 7. Propose and collect partner consent =="
CODE=$(post POST "/api/agreements/$AGR/propose" "$ADMIN" '{}')
check "agreement proposed" "$CODE" "200"
check "three partners awaiting decision" "$(j 'o.data.awaitingDecisionFrom' < /tmp/body)" "3"

# Give each partner a login linked to their partner record.
i=0
for P in "$P_A" "$P_B" "$P_C"; do
  i=$((i+1))
  post POST /api/admin/users "$ADMIN" "{\"email\":\"p$i@teacheasy.ng\",\"password\":\"PartnerPass123!\",\"firstName\":\"Partner\",\"lastName\":\"$i\",\"roles\":[\"PARTNER\"]}" >/dev/null
  PUSER=$(j 'o.data.id' < /tmp/body)
  post PATCH "/api/partners/$P" "$ADMIN" "{}" >/dev/null
  npx --yes wrangler d1 execute teacheasy-db --local --command \
    "UPDATE partners SET user_id='$PUSER', status='ACTIVE' WHERE id='$P'" >/dev/null 2>&1
  post POST /api/auth/login "" "{\"email\":\"p$i@teacheasy.ng\",\"password\":\"PartnerPass123!\"}" >/dev/null
  eval "T_$i=$(j 'o.data.tokens.accessToken' < /tmp/body)"
done

get "/api/agreements/$AGR/mine" "$T_1" >/dev/null
check "partner A sees their own line" "$(j 'o.data.myLine.sharePercent' < /tmp/body)" "40"

for T in "$T_1" "$T_2" "$T_3"; do
  post POST "/api/agreements/$AGR/decision" "$T" '{"decision":"ACCEPTED"}' >/dev/null
done
check "agreement is ACCEPTED once all three consent" "$(j 'o.data.agreementStatus' < /tmp/body)" "ACCEPTED"

echo "== 8. Activate and model a distribution =="
CODE=$(post POST "/api/agreements/$AGR/activate" "$ADMIN" '{}')
check "super admin activates the agreement" "$CODE" "200"

# 1,000,000.00 naira = 100,000,000 kobo
post POST "/api/agreements/$AGR/preview" "$ADMIN" '{"poolKobo":100000000}' >/dev/null
check "partner A is allocated 40,000,000 kobo" "$(j 'o.data.allocations.find(a=>a.partnerCode==="PTR-A").amountKobo' < /tmp/body)" "40000000"
check "partner C is allocated 25,000,000 kobo" "$(j 'o.data.allocations.find(a=>a.partnerCode==="PTR-C").amountKobo' < /tmp/body)" "25000000"
check "nothing is left unallocated" "$(j 'o.data.unallocatedKobo' < /tmp/body)" "0"

# An amount that does not divide cleanly: 100 kobo across 40/35/25.
post POST "/api/agreements/$AGR/preview" "$ADMIN" '{"poolKobo":101}' >/dev/null
check "an indivisible pool still sums exactly" "$(j 'o.data.allocations.reduce((s,a)=>s+a.amountKobo,0)' < /tmp/body)" "101"
check "no remainder is lost" "$(j 'o.data.unallocatedKobo' < /tmp/body)" "0"

echo "== 9. Zero-trust guards =="
CODE=$(get /api/partners "$T_1")
check "a partner cannot enumerate other partners" "$CODE" "403"

CODE=$(get /api/admin/users "$T_1")
check "a partner cannot list users" "$CODE" "403"

CODE=$(get /api/admin/audit-logs "$T_1")
check "a partner cannot read the audit trail" "$CODE" "403"

CODE=$(post POST "/api/agreements/$AGR/decision" "$T_1" '{"decision":"REJECTED"}')
check "a partner cannot vote twice" "$CODE" "409"

# A second group and agreement that partner 1 is NOT party to.
post POST /api/partnership-groups "$ADMIN" '{"code":"OTHER","name":"Other Group"}' >/dev/null
G2=$(j 'o.data.id' < /tmp/body)
post POST "/api/partnership-groups/$G2/members" "$ADMIN" "{\"partnerId\":\"$P_B\"}" >/dev/null
post POST /api/agreements "$ADMIN" "{\"groupId\":\"$G2\",\"title\":\"Other deal\",\"effectiveFrom\":\"2026-09-01\"}" >/dev/null
AGR2=$(j 'o.data.id' < /tmp/body)
post PUT "/api/agreements/$AGR2/lines" "$ADMIN" "{\"lines\":[{\"partnerId\":\"$P_B\",\"shareType\":\"PERCENTAGE\",\"shareBps\":10000}]}" >/dev/null

CODE=$(get "/api/agreements/$AGR2/mine" "$T_1")
check "a partner cannot read an agreement they are not party to" "$CODE" "403"

CODE=$(post POST "/api/agreements/$AGR2/decision" "$T_1" '{"decision":"ACCEPTED"}')
check "a partner cannot sign an agreement they are not party to" "$CODE" "403"

echo "== 10. Deputy Super Admin and the approval gate =="
post POST /api/admin/users "$ADMIN" '{"email":"deputy@teacheasy.ng","password":"DeputyPass123!","firstName":"Deputy","lastName":"One","roles":["DEPUTY_SUPER_ADMIN"]}' >/dev/null
DEP_ID=$(j 'o.data.id' < /tmp/body)
post POST /api/auth/login "" '{"email":"deputy@teacheasy.ng","password":"DeputyPass123!"}' >/dev/null
DEP=$(j 'o.data.tokens.accessToken' < /tmp/body)

get /api/me "$DEP" >/dev/null
check "deputy routes to /deputy" "$(j 'o.data.dashboard.home' < /tmp/body)" "/deputy"

CODE=$(get /api/admin/users "$DEP")
check "deputy can read users by default" "$CODE" "200"

CODE=$(post POST "/api/admin/users/$DEP_ID/status" "$DEP" '{"status":"SUSPENDED"}')
check "deputy has no suspend permission by default" "$CODE" "403"

# Grant it, then confirm the self-suspension guard is what stops them.
post POST "/api/admin/users/$DEP_ID/permissions" "$ADMIN" '{"permission":"users.suspend","effect":"GRANT"}' >/dev/null
post POST /api/auth/login "" '{"email":"deputy@teacheasy.ng","password":"DeputyPass123!"}' >/dev/null
DEP=$(j 'o.data.tokens.accessToken' < /tmp/body)
CODE=$(post POST "/api/admin/users/$DEP_ID/status" "$DEP" '{"status":"SUSPENDED"}')
check "deputy cannot suspend themselves even when permitted" "$CODE" "400"

# Grant the deputy a sensitive permission, then confirm exercising it defers.
post POST "/api/admin/users/$DEP_ID/permissions" "$ADMIN" '{"permission":"settings.manage","effect":"GRANT"}' >/dev/null
post POST /api/auth/login "" '{"email":"deputy@teacheasy.ng","password":"DeputyPass123!"}' >/dev/null
DEP=$(j 'o.data.tokens.accessToken' < /tmp/body)

CODE=$(curl -s -o /tmp/body -w '%{http_code}' -X PUT "$BASE/api/admin/settings/platform.currency" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $DEP" -d '{"value":"USD","reason":"testing"}')
check "deputy's sensitive change is deferred, not applied" "$CODE" "202"
check "an approval request was raised" "$(j 'o.data.pendingApproval' < /tmp/body)" "true"
REQ=$(j 'o.data.request.id' < /tmp/body)

get /api/admin/settings/platform.currency "$ADMIN" >/dev/null
check "the setting is still unchanged" "$(j 'o.data.value' < /tmp/body)" "NGN"

CODE=$(post POST "/api/admin/approvals/$REQ/decide" "$DEP" '{"decision":"APPROVE"}')
check "deputy cannot approve their own request" "$CODE" "403"

CODE=$(post POST "/api/admin/approvals/$REQ/decide" "$ADMIN" '{"decision":"APPROVE"}')
check "super admin approves the request" "$CODE" "200"

get /api/admin/settings/platform.currency "$ADMIN" >/dev/null
check "the setting is applied after approval" "$(j 'o.data.value' < /tmp/body)" "USD"

echo "== 11. Session revocation takes effect immediately =="
post POST /api/auth/login "" '{"email":"p1@teacheasy.ng","password":"PartnerPass123!"}' >/dev/null
VICTIM=$(j 'o.data.tokens.accessToken' < /tmp/body)
check "token works before suspension" "$(get /api/me "$VICTIM")" "200"

P1_USER=$(npx --yes wrangler d1 execute teacheasy-db --local --json \
  --command "SELECT id FROM users WHERE email='p1@teacheasy.ng'" 2>/dev/null | j 'o[0].results[0].id')
post POST "/api/admin/users/$P1_USER/status" "$ADMIN" '{"status":"SUSPENDED","reason":"smoke test"}' >/dev/null
check "suspended user's live token stops working" "$(get /api/me "$VICTIM")" "401"

echo "== 12. Audit trail =="
get "/api/admin/audit-logs?perPage=100" "$ADMIN" >/dev/null
check "audit trail recorded the activity" "$(node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  const o=JSON.parse(d);
  const want=['bootstrap.super_admin_created','auth.login','partner.created','agreement.proposed',
              'agreement.decision','agreement.activated','approval.applied','user.status_changed'];
  const got=new Set(o.data.map(r=>r.action));
  console.log(want.every(a=>got.has(a))?'all':'missing:'+want.filter(a=>!got.has(a)))})" < /tmp/body)" "all"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
