#!/usr/bin/env bash
# NKLearn trials, plans and quota, against a running `npm run dev`.
#
# The one-trial rules are the point of this file: the account rule is a hard
# guarantee and the device rule is a best-effort deterrent, and both are
# asserted here so a regression in either is visible.
set -u

BASE="${BASE:-http://127.0.0.1:8787}"
PASS=0
FAIL=0

j() { EXPR="$1" node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const v=eval(process.env.EXPR);console.log(v===undefined?'':typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('')}})"; }
ck() { if [ "$2" = "$3" ]; then printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS+1));
       else printf '  \033[31mFAIL\033[0m %s (got %s want %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi; }
post() { curl -s -o /tmp/b -w '%{http_code}' -X "$1" "$BASE$2" -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} ${4:+-d "$4"}; }
get()  { curl -s -o /tmp/b -w '%{http_code}' "$BASE$1" ${2:+-H "Authorization: Bearer $2"}; }
d1()   { npx --yes wrangler d1 execute kamdova-db --local --json --command "$1" 2>/dev/null; }

mkteacher() { # mkteacher <email> -> echoes the access token
  post POST /api/admin/users "$AD" "{\"email\":\"$1\",\"password\":\"TeacherPass123!\",\"firstName\":\"T\",\"lastName\":\"X\",\"roles\":[\"TEACHER\"]}" >/dev/null
  post POST /api/auth/login "" "{\"email\":\"$1\",\"password\":\"TeacherPass123!\"}" >/dev/null
  j 'o.data.tokens.accessToken' </tmp/b
}

post POST /api/bootstrap/super-admin "" '{"email":"a@nk.ng","password":"SuperSecret123!","firstName":"Ada","lastName":"O"}' >/dev/null
post POST /api/auth/login "" '{"email":"a@nk.ng","password":"SuperSecret123!"}' >/dev/null
AD=$(j 'o.data.tokens.accessToken' </tmp/b)

echo "== KamDova brand and marketplace =="
T1=$(mkteacher t1@nk.ng)
get /api/teachers/me "$T1" >/dev/null
get /api/marketplace/products "$T1" >/dev/null
ck "brand is KamDova" "$(j 'o.data.brand.name' </tmp/b)" "KamDova"
ck "tagline is set" "$(j 'o.data.brand.tagline' </tmp/b)" "Create. Teach. Learn. Earn."
ck "both founding partners are named" "$(j 'o.data.brand.partners.join(" + ")' </tmp/b)" "Ndovera + Kambi Academy"
ck "four capability areas" "$(j 'o.data.areas.map(a=>a.code).join(",")' </tmp/b)" "TEACHER,STUDENT,MARKETPLACE,PARTNERSHIP"
ck "teacher area has eight features" "$(j 'o.data.areas.find(a=>a.code==="TEACHER").features.length' </tmp/b)" "8"
ck "AI Lesson Planner is first for teachers" "$(j 'o.data.areas.find(a=>a.code==="TEACHER").features[0].name' </tmp/b)" "AI Lesson Planner"
ck "student area has six features" "$(j 'o.data.areas.find(a=>a.code==="STUDENT").features.length' </tmp/b)" "6"
ck "marketplace area has four features" "$(j 'o.data.areas.find(a=>a.code==="MARKETPLACE").features.length' </tmp/b)" "4"
ck "partnership names Ndovera and Kambi" "$(j 'o.data.areas.find(a=>a.code==="PARTNERSHIP").features.slice(0,2).map(f=>f.name).join(", ")' </tmp/b)" "Ndovera, Kambi Academy"
ck "retired NKLearn products are gone" "$(j 'o.data.all.filter(p=>p.code.startsWith("NKLEARN")).length' </tmp/b)" "0"
get /api/marketplace/plans "$T1" >/dev/null
ck "six plans listed" "$(j 'o.data.length' </tmp/b)" "6"
ck "N1,000 starter bundle" "$(j 'o.data.find(p=>p.code==="STARTER_5").priceFormatted' </tmp/b)" "₦1,000.00"
ck "N2,000 monthly 18" "$(j 'o.data.find(p=>p.code==="MONTHLY_18").priceFormatted' </tmp/b)" "₦2,000.00"
ck "N8,000 termly" "$(j 'o.data.find(p=>p.code==="TERMLY_ALL").priceFormatted' </tmp/b)" "₦8,000.00"
ck "termly reads as unlimited" "$(j 'o.data.find(p=>p.code==="TERMLY_ALL").quotaLabel' </tmp/b)" "Unlimited lesson plans"
ck "weekly plan labels its period" "$(j 'o.data.find(p=>p.code==="WEEKLY_10").quotaLabel' </tmp/b)" "10 lesson plans per week"
ck "bundle does not claim a period" "$(j 'o.data.find(p=>p.code==="STARTER_5").quotaLabel' </tmp/b)" "5 lesson plans"

echo "== No plan means no generation =="
get /api/billing/me "$T1" >/dev/null
ck "new teacher has no entitlement" "$(j 'o.data.entitlement.active' </tmp/b)" "false"
ck "trial is offered" "$(j 'o.data.trial.available' </tmp/b)" "true"
ck "trial length is 3 days" "$(j 'o.data.trial.days' </tmp/b)" "3"
post POST /api/lessons "$T1" '{"topic":"Booting","classCode":"PRY3","subjectCode":"BASIC_SCIENCE"}' >/dev/null
L1=$(j 'o.data.id' </tmp/b)
ck "generation refused without a plan" "$(post POST /api/lessons/$L1/generate "$T1" '{}')" "403"
ck "and says to start a trial" "$(j 'o.error.message.includes("free trial")' </tmp/b)" "true"

echo "== Trial: one per account =="
post POST /api/billing/trial "$T1" '{"deviceId":"device-aaa-111","platform":"ANDROID","deviceModel":"Tecno Spark"}' >/dev/null
ck "trial granted" "$(j 'o.data.granted' </tmp/b)" "true"
ck "trial gives 5 lesson plans" "$(j 'o.data.entitlement.quotaLimit' </tmp/b)" "5"
ck "trial source is TRIAL" "$(j 'o.data.entitlement.source' </tmp/b)" "TRIAL"
ck "same account cannot claim twice" "$(post POST /api/billing/trial "$T1" '{"deviceId":"device-bbb-222","platform":"ANDROID"}')" "409"
# While the trial is still running the accurate reason is that they already
# have a plan; the account rule is what bites once it has expired.
ck "refused while the trial is live" "$(j 'o.error.details.outcome' </tmp/b)" "ALREADY_SUBSCRIBED"

U1=$(d1 "SELECT id FROM users WHERE email='t1@nk.ng'" | j 'o[0].results[0].id')
d1 "UPDATE subscriptions SET expires_at='2020-01-01T00:00:00.000Z' WHERE user_id='$U1'" >/dev/null
ck "precondition: the trial now reads as expired" "$(d1 "SELECT expires_at FROM subscriptions WHERE user_id='$U1'" | j 'o[0].results[0].expires_at')" "2020-01-01T00:00:00.000Z"
ck "an EXPIRED trial still cannot be re-claimed" "$(post POST /api/billing/trial "$T1" '{"deviceId":"device-bbb-222","platform":"ANDROID"}')" "409"
ck "and the account rule is the reason" "$(j 'o.error.details.outcome' </tmp/b)" "ACCOUNT_ALREADY_CLAIMED"
d1 "UPDATE subscriptions SET expires_at='2099-01-01T00:00:00.000Z' WHERE user_id='$U1'" >/dev/null

echo "== Trial: one per device (best effort) =="
T2=$(mkteacher t2@nk.ng)
ck "second account, SAME device, is refused" "$(post POST /api/billing/trial "$T2" '{"deviceId":"device-aaa-111","platform":"ANDROID"}')" "409"
ck "refusal reason is the device" "$(j 'o.error.details.outcome' </tmp/b)" "DEVICE_ALREADY_CLAIMED"
ck "message does not name the other account" "$(j 'o.error.message.includes("@")' </tmp/b)" "false"

T3=$(mkteacher t3@nk.ng)
ck "second account, DIFFERENT device, is allowed" "$(post POST /api/billing/trial "$T3" '{"deviceId":"device-ccc-333","platform":"IOS"}')" "201"

# Same raw id on a different platform is a different device.
T4=$(mkteacher t4@nk.ng)
ck "same id on another platform is a different device" "$(post POST /api/billing/trial "$T4" '{"deviceId":"device-aaa-111","platform":"IOS"}')" "201"

echo "== Raw device ids are never stored =="
ck "no raw device id in the database" "$(d1 "SELECT COUNT(*) AS n FROM trial_claims WHERE device_hash LIKE '%device-aaa%'" | j 'o[0].results[0].n')" "0"
ck "hashes are stored instead" "$(d1 "SELECT LENGTH(device_hash) AS n FROM trial_claims WHERE device_hash IS NOT NULL LIMIT 1" | j 'o[0].results[0].n')" "64"

echo "== Refused attempts are recorded for abuse detection =="
get "/api/admin/billing/trial-attempts" "$AD" >/dev/null
ck "device refusals are counted" "$(j 'o.data.breakdown.find(b=>b.outcome==="DEVICE_ALREADY_CLAIMED").attempts>=1' </tmp/b)" "true"

echo "== Quota is enforced =="
if [ "${RUN_AI:-0}" = "1" ]; then
  ck "generation now passes the gate" "$(post POST /api/lessons/$L1/generate "$T1" '{}')" "201"
  get /api/billing/me "$T1" >/dev/null
  ck "a successful generation consumes one slot" "$(j 'o.data.entitlement.quotaUsed' </tmp/b)" "1"
  ck "four of five remain" "$(j 'o.data.entitlement.quotaRemaining' </tmp/b)" "4"
else
  echo "  (live generation skipped -- set RUN_AI=1 to spend neurons)"
fi

# Burn the allowance to test the ceiling without spending real tokens. The
# counter row already exists (the refund cycle above created it), so this is an
# UPDATE -- an INSERT would collide with UNIQUE(user_id, metric, period_start).
SUB=$(d1 "SELECT id FROM subscriptions WHERE user_id='$U1'" | j 'o[0].results[0].id')
PSTART=$(d1 "SELECT started_at FROM subscriptions WHERE id='$SUB'" | j 'o[0].results[0].started_at')
d1 "INSERT INTO usage_counters (id,user_id,subscription_id,metric,period_start,period_end,used,created_at,updated_at) VALUES ('uc-test','$U1','$SUB','LESSON_GENERATION','$PSTART','2099-01-01T00:00:00.000Z',5,'2026-08-31T00:00:00Z','2026-08-31T00:00:00Z') ON CONFLICT(user_id,metric,period_start) DO UPDATE SET used=5" >/dev/null
ck "the allowance was actually burnt" "$(d1 "SELECT used FROM usage_counters WHERE user_id='$U1'" | j 'o[0].results[0].used')" "5"
get /api/billing/me "$T1" >/dev/null
ck "allowance shows exhausted" "$(j 'o.data.entitlement.quotaRemaining' </tmp/b)" "0"
ck "canGenerate is false" "$(j 'o.data.entitlement.canGenerate' </tmp/b)" "false"
ck "generation blocked at the ceiling" "$(post POST /api/lessons/$L1/generate "$T1" '{}')" "403"
ck "error names the limit" "$(j 'o.error.message.includes("all 5 lesson plans")' </tmp/b)" "true"

echo "== Buying a plan =="
post POST /api/billing/orders "$T2" '{"planCode":"MONTHLY_18"}' >/dev/null
ORD=$(j 'o.data.id' </tmp/b)
ck "order placed" "$(j 'o.data.status' </tmp/b)" "PENDING"
ck "order priced at N2,000" "$(j 'o.data.amountFormatted' </tmp/b)" "₦2,000.00"
ck "order reference is KamDova-branded" "$(j 'o.data.reference.startsWith("KDV-")' </tmp/b)" "true"
get /api/billing/me "$T2" >/dev/null
ck "an unpaid order grants nothing" "$(j 'o.data.entitlement.active' </tmp/b)" "false"
ck "a teacher cannot mark their own order paid" "$(post POST /api/admin/billing/orders/$ORD/mark-paid "$T2" '{}')" "403"
ck "super admin marks it paid" "$(post POST /api/admin/billing/orders/$ORD/mark-paid "$AD" '{}')" "200"
get /api/billing/me "$T2" >/dev/null
ck "subscription is now active" "$(j 'o.data.entitlement.active' </tmp/b)" "true"
ck "quota is the plan's 18" "$(j 'o.data.entitlement.quotaLimit' </tmp/b)" "18"
ck "period is monthly" "$(j 'o.data.entitlement.periodEnd!==null' </tmp/b)" "true"
ck "paying replaces the trial offer" "$(j 'o.data.entitlement.source' </tmp/b)" "PURCHASE"
ck "an order cannot be paid twice" "$(post POST /api/admin/billing/orders/$ORD/mark-paid "$AD" '{}')" "409"

echo "== Super Admin controls the numbers =="
post PUT /api/admin/settings/billing.default_weekly_lesson_quota "$AD" '{"value":25,"reason":"raising the weekly cap"}' >/dev/null
ck "weekly cap is editable" "$(j 'o.data.value' </tmp/b)" "25"
post PUT /api/admin/settings/trial.days "$AD" '{"value":7,"reason":"longer trial"}' >/dev/null
ck "trial length is editable" "$(j 'o.data.value' </tmp/b)" "7"
post PATCH /api/admin/billing/plans/MONTHLY_18 "$AD" '{"priceKobo":250000,"lessonQuota":20}' >/dev/null
ck "plan price is editable" "$(j 'o.data.updated' </tmp/b)" "true"
get /api/marketplace/plans "$AD" >/dev/null
ck "new price is live" "$(j 'o.data.find(p=>p.code==="MONTHLY_18").priceFormatted' </tmp/b)" "₦2,500.00"
get /api/billing/me "$T2" >/dev/null
ck "existing subscriber keeps their old quota" "$(j 'o.data.entitlement.quotaLimit' </tmp/b)" "18"

post PUT /api/admin/settings/trial.enabled "$AD" '{"value":false,"reason":"pausing trials"}' >/dev/null
T5=$(mkteacher t5@nk.ng)
ck "trials can be switched off" "$(post POST /api/billing/trial "$T5" '{"deviceId":"device-zzz-999","platform":"ANDROID"}')" "409"
ck "and the reason is reported" "$(j 'o.error.details.outcome' </tmp/b)" "TRIALS_DISABLED"

echo "== Zero trust on billing =="
ck "a teacher cannot list all subscriptions" "$(get /api/admin/billing/subscriptions "$T1")" "403"
ck "a teacher cannot create a plan" "$(post POST /api/admin/billing/plans "$T1" '{"code":"FREE","name":"Free","priceKobo":0,"billingPeriod":"WEEKLY"}')" "403"
ck "a teacher cannot grant themselves a subscription" "$(post POST /api/admin/billing/subscriptions/grant "$T1" '{"userId":"x","days":30,"reason":"nope"}')" "403"
get /api/billing/orders "$T1" >/dev/null
ck "a teacher sees only their own orders" "$(j 'o.data.length' </tmp/b)" "0"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
