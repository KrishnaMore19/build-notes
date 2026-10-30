#!/usr/bin/env bash
# Quick end-to-end check of every endpoint. Usage: scripts/smoke.sh [base-url]   (needs curl + node)
B=${1:-http://localhost:3000}
js() { node -pe "const j=JSON.parse(require('fs').readFileSync(0)); $1"; }
H='content-type: application/json'
fail=0; check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }

check "health" "$(curl -s $B/health | js 'j.ok')" "true"
V=$(curl -s "$B/api/vehicles?limit=1" | js 'j.data[0].id')
check "vehicles page size" "$(curl -s "$B/api/vehicles?limit=5" | js 'j.data.length')" "5"
check "vehicles second request is cached" "$(curl -s -o /dev/null -D- "$B/api/vehicles?limit=5" | grep -i '^x-cache' | tr -d '\r' | awk '{print $2}')" "HIT"
check "vehicle detail" "$(curl -s "$B/api/vehicles/$V" | js 'j.id === "'$V'"')" "true"
check "vehicle 404" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/vehicles/11111111-1111-4111-8111-111111111111)" "404"
check "bad uuid 400" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/vehicles/nope)" "400"
T=$(curl -s "$B/api/vehicles/$V/trips?limit=1" | js 'j.data[0].id')
check "trip points" "$(curl -s "$B/api/trips/$T/points?every=5" | js 'j.data.length > 0')" "true"
check "unresolved alerts" "$(curl -s "$B/api/alerts?limit=50" | js 'j.data.every(a => a.state !== "resolved") && j.data.length > 0')" "true"
A=$(curl -s "$B/api/alerts?state=open&limit=1" | js 'j.data[0].id')
check "acknowledge" "$(curl -s -X PATCH -H "$H" -d '{"action":"acknowledge"}' $B/api/alerts/$A | js 'j.state')" "acknowledged"
check "acknowledge twice -> 409" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$H" -d '{"action":"acknowledge"}' $B/api/alerts/$A)" "409"
check "resolve" "$(curl -s -X PATCH -H "$H" -d '{"action":"resolve"}' $B/api/alerts/$A | js 'j.state')" "resolved"
check "resolve twice -> 409" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$H" -d '{"action":"resolve"}' $B/api/alerts/$A)" "409"
check "bad action -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$H" -d '{"action":"delete"}' $B/api/alerts/$A)" "400"
check "unknown alert -> 404" "$(curl -s -o /dev/null -w '%{http_code}' -X PATCH -H "$H" -d '{"action":"resolve"}' $B/api/alerts/11111111-1111-4111-8111-111111111111)" "404"
exit $fail
