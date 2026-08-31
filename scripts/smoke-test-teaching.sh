#!/usr/bin/env bash
# End-to-end walk through Modules 4-6 against a running `npm run dev`.
# Covers the template engine, lesson creation, ownership guards, note editing,
# publishing, share-link lifecycle and the public student page.
#
#   npm run dev
#   bash scripts/smoke-test-teaching.sh
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

post POST /api/bootstrap/super-admin "" '{"email":"a@t.ng","password":"SuperSecret123!","firstName":"Ada","lastName":"O"}' >/dev/null
post POST /api/auth/login "" '{"email":"a@t.ng","password":"SuperSecret123!"}' >/dev/null
AD=$(j 'o.data.tokens.accessToken' </tmp/b)

post POST /api/admin/users "$AD" '{"email":"t1@t.ng","password":"TeacherPass123!","firstName":"Bola","lastName":"A","roles":["TEACHER"]}' >/dev/null
post POST /api/auth/login "" '{"email":"t1@t.ng","password":"TeacherPass123!"}' >/dev/null
T=$(j 'o.data.tokens.accessToken' </tmp/b)
post POST /api/admin/users "$AD" '{"email":"t2@t.ng","password":"TeacherPass123!","firstName":"Chidi","lastName":"B","roles":["TEACHER"]}' >/dev/null
post POST /api/auth/login "" '{"email":"t2@t.ng","password":"TeacherPass123!"}' >/dev/null
T2=$(j 'o.data.tokens.accessToken' </tmp/b)

echo "== Module 5: template engine =="
get /api/templates "$T" >/dev/null
ck "teacher can list teacher templates" "$(j 'o.data.length' </tmp/b)" "2"
ck "Template 1 is present" "$(j 'o.data.find(t=>t.code==="STANDARD").name' </tmp/b)" "Template 1 - Standard Lesson Note"
get /api/templates/STANDARD "$T" >/dev/null
ck "Template 1 has 9 sections" "$(j 'o.data.structure.sections.length' </tmp/b)" "9"
ck "presentation is a steps section" "$(j 'o.data.structure.sections.find(s=>s.key==="presentation").type' </tmp/b)" "steps"
ck "objectives carry the preamble" "$(j 'o.data.structure.sections.find(s=>s.key==="learningObjectives").preamble' </tmp/b)" "By the end of the lesson, pupils should be able to:"
get /api/templates/PROFESSIONAL "$T" >/dev/null
ck "Template 2 development is a table" "$(j 'o.data.structure.sections.find(s=>s.key==="lessonDevelopment").type' </tmp/b)" "table"
ck "Template 2 grid has 4 columns" "$(j 'o.data.structure.sections.find(s=>s.key==="lessonDevelopment").columns.map(c=>c.key).join(",")' </tmp/b)" "step,teacherActivities,pupilActivities,learningPoint"
get /api/templates/STANDARD/schema "$T" >/dev/null
ck "schema omits the teacher-input header" "$(j 'Object.keys(o.data.schema.properties).includes("header")' </tmp/b)" "false"
ck "schema is strict-tool-use ready" "$(j 'o.data.schema.additionalProperties' </tmp/b)" "false"
ck "teacher cannot edit a template" "$(post PUT /api/templates/STANDARD "$T" '{"structure":{"sections":[]}}')" "403"

echo "== Module 4: teacher profile =="
get /api/teachers/me "$T" >/dev/null
ck "teacher record created on first use" "$(j 'o.data.status' </tmp/b)" "PENDING"
ck "default template is Template 1" "$(j 'o.data.defaultTemplateCode' </tmp/b)" "STANDARD"
post PATCH /api/teachers/me "$T" '{"schoolName":"GPS Ikeja","defaultTemplateCode":"PROFESSIONAL","yearsExperience":6}' >/dev/null
ck "teacher can choose a default template" "$(j 'o.data.defaultTemplateCode' </tmp/b)" "PROFESSIONAL"
post PUT /api/teachers/me/subjects "$T" '{"subjects":["BASIC_SCIENCE","MATHEMATICS"]}' >/dev/null
ck "subjects saved" "$(j 'o.data.subjects.length' </tmp/b)" "2"
ck "unknown subject rejected" "$(post PUT /api/teachers/me/subjects "$T" '{"subjects":["NOPE"]}')" "400"

echo "== Module 4: lessons =="
post POST /api/lessons "$T" '{"topic":"Introduction to Booting","subtopic":"Meaning and types of booting","classCode":"PRY3","subjectCode":"BASIC_SCIENCE","week":1,"term":"FIRST","durationMinutes":35,"classSize":8,"averageAge":8,"sexMix":"MIXED","theme":"Computer Basics"}' >/dev/null
L=$(j 'o.data.id' </tmp/b)
ck "lesson created" "$(j 'o.data.topic' </tmp/b)" "Introduction to Booting"
ck "lesson inherits the chosen default template" "$(j 'o.data.templateCode' </tmp/b)" "PROFESSIONAL"
ck "lesson starts as DRAFT" "$(j 'o.data.status' </tmp/b)" "DRAFT"
ck "a lesson needs a topic" "$(post POST /api/lessons "$T" '{"classCode":"PRY3"}')" "400"
post POST /api/lessons "$T" '{"topic":"Fractions","classCode":"PRY3","subjectCode":"MATHEMATICS","templateCode":"STANDARD"}' >/dev/null
ck "templateCode overrides the default" "$(j 'o.data.templateCode' </tmp/b)" "STANDARD"

echo "== Zero trust: lesson ownership =="
ck "another teacher cannot read it"     "$(get /api/lessons/$L "$T2")" "403"
ck "another teacher cannot edit it"     "$(post PATCH /api/lessons/$L "$T2" '{"topic":"Hijacked"}')" "403"
ck "another teacher cannot delete it"   "$(post DELETE /api/lessons/$L "$T2" '')" "403"
ck "another teacher cannot generate"    "$(post POST /api/lessons/$L/generate "$T2" '{}')" "403"
get /api/lessons "$T2" >/dev/null
ck "another teacher's list is empty" "$(j 'o.data.length' </tmp/b)" "0"
get /api/lessons "$T" >/dev/null
ck "owner sees their own two" "$(j 'o.data.length' </tmp/b)" "2"
ck "reviewer with content.read may read" "$(get /api/lessons/$L "$AD")" "200"

echo "== Billing gates before the AI is ever called =="
# Correct order: no plan means no provider call, so no spend at all.
ck "no plan means no generation" "$(post POST /api/lessons/$L/generate "$T" '{}')" "403"
post POST /api/billing/trial "$T" '{"deviceId":"teach-test-device","platform":"ANDROID"}' >/dev/null

# A live generation calls Workers AI, which bills the Cloudflare account even in
# local dev and takes ~20s. Opt in with RUN_AI=1; skipped by default so the
# suite stays fast and free to run.
if [ "${RUN_AI:-0}" = "1" ]; then
  echo "== AI generation (live Workers AI call) =="
  ck "generation succeeds" "$(post POST /api/lessons/$L/generate "$T" '{}')" "201"
  ck "a note version is returned" "$(j 'o.data.version' </tmp/b)" "1"
  ck "the allowance was decremented" "$(j 'o.data.allowance.remaining' </tmp/b)" "4"
  get /api/lessons/$L "$T" >/dev/null
  ck "lesson is READY afterwards" "$(j 'o.data.status' </tmp/b)" "READY"
  ck "a teacher note now exists" "$(j 'o.data.teacherNotes.length' </tmp/b)" "1"
  NOTE_ID=$(j 'o.data.teacherNotes[0].id' </tmp/b)
  get /api/notes/teacher/$NOTE_ID "$T" >/dev/null
  ck "the note renders into blocks" "$(j 'o.data.blocks.length>=6' </tmp/b)" "true"
  ck "objectives came back as a list" "$(j 'Array.isArray(o.data.content.learningObjectives)' </tmp/b)" "true"
else
  echo "== AI generation (skipped -- set RUN_AI=1 to spend neurons) =="
fi

echo "== Module 6: student notes =="
TPL=$(d1 "SELECT id FROM lesson_templates WHERE code='STUDENT_STANDARD'" | j 'o[0].results[0].id')
SN=$(node -e "console.log(crypto.randomUUID())")
# Seeded through a helper script -- see scripts/seed-test-note.mjs for why.
node scripts/seed-test-note.mjs "$SN" "$L" "$TPL" scripts/.tmp-seed-note.sql
npx --yes wrangler d1 execute kamdova-db --local --file=scripts/.tmp-seed-note.sql >/dev/null 2>&1 || true
rm -f scripts/.tmp-seed-note.sql
ck "precondition: the student note was seeded" "$(d1 "SELECT COUNT(*) AS n FROM student_notes WHERE id='$SN'" | j 'o[0].results[0].n')" "1"

get /api/notes/student/$SN "$T" >/dev/null
ck "teacher reads their student note" "$(j 'o.data.status' </tmp/b)" "DRAFT"
ck "note ships rendered blocks" "$(j 'o.data.blocks.length>0' </tmp/b)" "true"
ck "another teacher cannot read it" "$(get /api/notes/student/$SN "$T2")" "403"

ck "cannot share before publishing" "$(post POST /api/notes/student/$SN/shares "$T" '{}')" "409"
post PATCH /api/notes/student/$SN "$T" '{"content":{"summary":"Booting is how a computer starts up."}}' >/dev/null
ck "teacher edits one section" "$(j 'o.data.content.summary' </tmp/b)" "Booting is how a computer starts up."
ck "the other sections survive the edit" "$(j 'o.data.content.keyPoints.length' </tmp/b)" "2"
ck "an invalid edit is rejected" "$(post PATCH /api/notes/student/$SN "$T" '{"content":{"keyPoints":"not a list"}}')" "422"
ck "publish succeeds" "$(post POST /api/notes/student/$SN/publish "$T" '{}')" "200"

echo "== Module 6: share links and the public page =="
post POST /api/notes/student/$SN/shares "$T" '{"label":"Primary 3 WhatsApp"}' >/dev/null
SLUG=$(j 'o.data.slug' </tmp/b)
ck "share link created" "$([ -n "$SLUG" ] && echo ok)" "ok"
ck "share page loads with no session" "$(curl -s -o /tmp/p -w '%{http_code}' $BASE/s/$SLUG)" "200"
ck "page renders the edited note" "$(grep -c 'Booting is how a computer starts up' /tmp/p)" "1"
ck "page is marked noindex" "$([ "$(grep -c noindex /tmp/p)" -ge 1 ] && echo yes)" "yes"
ck "unknown slug is 404" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/s/definitely-not-a-real-slug)" "404"
ck "json form works for the app" "$(get /s/$SLUG/json)" "200"

get "/api/notes/student/$SN/shares" "$T" >/dev/null
SHARE_ID=$(j 'o.data[0].id' </tmp/b)
ck "view count recorded" "$(j 'o.data[0].viewCount>=1' </tmp/b)" "true"
post DELETE /api/notes/student/$SN/shares/$SHARE_ID "$T" '' >/dev/null
ck "revoked link stops working" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/s/$SLUG)" "404"

post POST /api/notes/student/$SN/shares "$T" '{}' >/dev/null
SLUG2=$(j 'o.data.slug' </tmp/b)
ck "a fresh link works" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/s/$SLUG2)" "200"
post POST /api/notes/student/$SN/unpublish "$T" '{}' >/dev/null
ck "unpublishing kills live links" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/s/$SLUG2)" "404"

echo "== Module 6: export =="
post POST /api/notes/student/$SN/publish "$T" '{}' >/dev/null
ck "markdown export" "$(get "/api/notes/student/$SN/export?format=markdown" "$T")" "200"
ck "markdown carries section headings" "$([ "$(grep -c '^## ' /tmp/b)" -ge 6 ] && echo yes)" "yes"
ck "html export" "$(get "/api/notes/student/$SN/export?format=html" "$T")" "200"
ck "unsupported format rejected" "$(get "/api/notes/student/$SN/export?format=pdf" "$T")" "400"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
