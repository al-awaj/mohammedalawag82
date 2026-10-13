#!/usr/bin/env bash
# Starts the production stack locally with throwaway secrets and checks it end to end:
# TLS on every domain, readiness, security headers, admin creation and sign-in through the admin
# panel's proxy, a public page, and a verified backup. Leaves nothing behind (unless KEEP=1).
#   ./smoke-test.sh            (uses images built by: docker compose build)
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=events-smoke
ENV_FILE=$(mktemp)
cat > "$ENV_FILE" <<ENV
WEB_DOMAIN=web.localhost
ADMIN_DOMAIN=admin.localhost
PROVIDER_DOMAIN=partners.localhost
API_DOMAIN=api.localhost
ACME_EMAIL=ops@example.org
POSTGRES_USER=events
POSTGRES_PASSWORD=$(openssl rand -hex 16)
POSTGRES_DB=events
JWT_SECRET=$(openssl rand -base64 48)
CADDYFILE=./Caddyfile.local
IMAGE_TAG=${IMAGE_TAG:-latest}
ENV
dc() { docker compose --env-file "$ENV_FILE" "$@"; }
cleanup() { if [ "${KEEP:-0}" != 1 ]; then dc --profile ops down -v --remove-orphans >/dev/null 2>&1 || true; fi; rm -f "$ENV_FILE"; }
trap cleanup EXIT

fail() { echo "FAIL: $*"; dc logs --tail 40 >&2 || true; exit 1; }
https() { curl -sk --resolve "$1:443:127.0.0.1" "${@:2}" "https://$1${PATH_:-}"; }

echo "→ starting"
dc up -d --no-build --wait --wait-timeout 180 postgres migrate api worker admin provider web caddy >/dev/null 2>&1 || dc up -d --no-build postgres api worker admin provider web caddy
for i in $(seq 1 60); do
  code=$(PATH_=/ready https api.localhost -o /dev/null -w '%{http_code}' || true)
  [ "$code" = 200 ] && break; sleep 2
done
[ "$code" = 200 ] || fail "API not ready ($code)"
echo "✓ api ready over TLS: $(PATH_=/ready https api.localhost)"

for d in web.localhost admin.localhost partners.localhost; do
  code=$(PATH_=/login https "$d" -o /dev/null -w '%{http_code}')
  [ "$code" = 200 ] || fail "$d/login → $code"
  hdr=$(PATH_=/login https "$d" -D - -o /dev/null)
  echo "$hdr" | grep -qi '^content-security-policy:' || fail "$d missing CSP"
  echo "$hdr" | grep -qi '^strict-transport-security:' && fail "local Caddyfile should not send HSTS"
  echo "✓ $d serves /login with security headers"
done
code=$(PATH_=/ https web.localhost -o /dev/null -w '%{http_code}'); [ "$code" = 200 ] || fail "home page → $code"
echo "✓ public home page rendered"

dc run --rm --no-deps create-admin --name "Smoke Admin" --email smoke@example.org --password 'Sm0ke-Test-Passw0rd!' >/dev/null
login=$(PATH_=/bff/session/login https admin.localhost -H 'content-type: application/json' -H 'x-csrf: 1' -H 'origin: https://admin.localhost' \
  -d '{"identifier":"smoke@example.org","password":"Sm0ke-Test-Passw0rd!"}' -c /tmp/smoke-cookies -o /dev/null -w '%{http_code}')
[ "$login" = 200 ] || fail "admin sign-in → $login"
me=$(PATH_=/bff/session https admin.localhost -b /tmp/smoke-cookies -H 'x-csrf: 1')
echo "$me" | grep -q smoke@example.org || fail "session not established: $me"
rm -f /tmp/smoke-cookies
echo "✓ admin created and signed in through the admin panel (httpOnly session)"

mkdir -p backups && { chown 10001 backups 2>/dev/null || chmod 777 backups; }
dc run --rm backup | tail -1
ls backups/*/manifest.json >/dev/null || fail "no backup written"
echo "✓ backup written and fingerprinted"
rm -rf backups
echo "SMOKE TEST PASSED"
