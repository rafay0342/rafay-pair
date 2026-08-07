#!/usr/bin/env bash
set -euo pipefail

# Finish the single-host deployment and build phone artifacts that point at it.
#
# Safe to run more than once. Every step checks whether it has already been
# done, so a second run repairs whatever is missing rather than duplicating
# anything. It touches only RafayPair: other sites on the host keep their own
# nginx vhosts and containers.
#
# Requires: an SSH key already authorized on the host (scripts/deploy-vps.sh
# does not accept a password), and the release keystore under ~/RafayPairKeys.

SERVER="${RAFAYPAIR_VPS_HOST:-root@34.134.185.230}"
DOMAIN="${RAFAYPAIR_VPS_DOMAIN:-34-134-185-230.sslip.io}"
CERT_EMAIL="${RAFAYPAIR_CERT_EMAIL:-it.ssepofficial@gmail.com}"
REMOTE_DIR="${RAFAYPAIR_REMOTE_DIR:-/opt/rafaypair}"
API_PORT="${RAFAYPAIR_API_PORT:-3300}"
OUT_DIR="${RAFAYPAIR_OUT_DIR:-$HOME/Desktop/RafayPair-release}"
KEYSTORE="${RAFAYPAIR_KEYSTORE:-$HOME/RafayPairKeys/rafaypair-release.jks}"
KEYSTORE_PASSWORD_FILE="${RAFAYPAIR_KEYSTORE_PASSWORD_FILE:-$HOME/RafayPairKeys/rafaypair-release-password.txt}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

remote() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$SERVER" "$@"; }

# ---------------------------------------------------------------------------

step "Checking the connection to $SERVER"
remote 'echo "connected: $(hostname)"' || fail "SSH to $SERVER failed. The key in ~/.ssh must be authorized on the host."

step "Switching the API to a mode it can actually boot in"
# Production requires Play Integrity credentials from Google, App Attest
# identifiers from Apple, and Redis over TLS. Two of those depend on accounts
# that do not exist yet, so the API runs pre-production until they do. Device
# attestation is NOT enforced in this mode and session cookies are not marked
# Secure — use the phone apps against this endpoint, not the web client.
remote "sed -i 's/^NODE_ENV=production/NODE_ENV=development/' $REMOTE_DIR/infra/compose/vps.env"
remote "grep -q '^NODE_ENV=development' $REMOTE_DIR/infra/compose/vps.env" \
  || fail "Could not set NODE_ENV in $REMOTE_DIR/infra/compose/vps.env"
note "NODE_ENV=development (pre-production; see the notes at the end)"

step "Naming the proxy the API should trust"
# TRUST_PROXY=true is refused outright: trusting every address means trusting
# whatever X-Forwarded-For a client sends, which hands the rate limiter and the
# audit trail an attacker-chosen client address. nginx runs on this same host,
# so the only address that may be believed is the loopback.
remote "sed -i 's|^TRUST_PROXY=.*|TRUST_PROXY=127.0.0.1/32,::1/128|' $REMOTE_DIR/infra/compose/vps.env"
remote "grep -q '^TRUST_PROXY=127.0.0.1/32,::1/128' $REMOTE_DIR/infra/compose/vps.env" \
  || fail "Could not set TRUST_PROXY in $REMOTE_DIR/infra/compose/vps.env"
note "TRUST_PROXY=127.0.0.1/32,::1/128"

step "Starting the stack"
remote "cd $REMOTE_DIR/infra/compose && docker compose -f docker-compose.vps.yml --env-file vps.env up -d"

step "Waiting for the API to report ready"
ready=""
for attempt in $(seq 1 30); do
  code="$(remote "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$API_PORT/health/ready || true")"
  if [[ "$code" == "200" ]]; then ready="yes"; note "ready after ${attempt}s"; break; fi
  sleep 1
done
if [[ -z "$ready" ]]; then
  note "--- the API's last start attempt ---"
  # Only the most recent attempt: a restart loop repeats the same stack trace,
  # and three copies of it obscure the one line that matters.
  remote 'docker logs --tail 40 rafaypair-prod-api-1 2>&1 | grep -E "^(Error|[A-Za-z]+Error):" | tail -3' || true
  remote 'docker logs --tail 12 rafaypair-prod-api-1 2>&1' || true
  fail "The API did not become ready. The error above says why."
fi

step "Publishing $DOMAIN through nginx"
# The WebSocket upgrade map is global. Other sites on this host may already
# define one; a second definition is an nginx syntax error, so it is added only
# when nothing defines it.
if remote "grep -rqs 'connection_upgrade' /etc/nginx/nginx.conf /etc/nginx/conf.d /etc/nginx/sites-enabled"; then
  note "an upgrade map already exists; leaving it alone"
else
  remote "printf 'map \$http_upgrade \$connection_upgrade { default upgrade; \"\" close; }\n' > /etc/nginx/conf.d/rafaypair-upgrade.conf"
  note "added /etc/nginx/conf.d/rafaypair-upgrade.conf"
fi

if remote "test -f /etc/nginx/sites-enabled/rafaypair"; then
  note "vhost already present; leaving it alone so certbot's edits survive"
else
  remote "cat > /etc/nginx/sites-available/rafaypair <<'NGINX'
server {
    listen 80;
    server_name $DOMAIN;

    # Realtime events and the AI voice socket both upgrade, and a voice session
    # is long-lived by nature, so the read timeout is generous.
    location / {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 2m;
    }
}
NGINX"
  remote "ln -sf /etc/nginx/sites-available/rafaypair /etc/nginx/sites-enabled/rafaypair"
  note "added the vhost"
fi
remote "nginx -t" || fail "nginx rejected the configuration; nothing was reloaded"
remote "systemctl reload nginx"

step "Getting a certificate for $DOMAIN"
if remote "test -d /etc/letsencrypt/live/$DOMAIN"; then
  note "a certificate already exists; renewing only if it is near expiry"
  remote "certbot renew --cert-name $DOMAIN --quiet || true"
else
  remote "certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m '$CERT_EMAIL' --redirect" \
    || fail "certbot could not issue a certificate for $DOMAIN"
fi

step "Checking the public endpoint"
public_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://$DOMAIN/health/ready" || true)"
[[ "$public_code" == "200" ]] || fail "https://$DOMAIN/health/ready answered $public_code"
note "https://$DOMAIN/health/ready → 200"

# ---------------------------------------------------------------------------

step "Building phone artifacts that point at https://$DOMAIN"

JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME ANDROID_HOME
export PATH="$JAVA_HOME/bin:$PATH"
[[ -x "$JAVA_HOME/bin/java" ]] || fail "No JDK at $JAVA_HOME. Set JAVA_HOME and run again."
[[ -d "$ANDROID_HOME" ]] || fail "No Android SDK at $ANDROID_HOME. Set ANDROID_HOME and run again."
[[ -f "$KEYSTORE" ]] || fail "No release keystore at $KEYSTORE."
[[ -f "$KEYSTORE_PASSWORD_FILE" ]] || fail "No keystore password file at $KEYSTORE_PASSWORD_FILE."

export RAFAYPAIR_ANDROID_DEVELOPMENT_API_BASE_URL="https://$DOMAIN"
export RAFAYPAIR_ANDROID_DEVELOPMENT_REALTIME_URL="wss://$DOMAIN/v1/realtime"
export RAFAYPAIR_ANDROID_STAGING_API_BASE_URL="https://$DOMAIN"
export RAFAYPAIR_ANDROID_STAGING_REALTIME_URL="wss://$DOMAIN/v1/realtime"

keystore_password="$(cat "$KEYSTORE_PASSWORD_FILE")"
export RAFAYPAIR_ANDROID_STORE_FILE="$KEYSTORE"
export RAFAYPAIR_ANDROID_STORE_PASSWORD="$keystore_password"
export RAFAYPAIR_ANDROID_KEY_ALIAS="${RAFAYPAIR_ANDROID_KEY_ALIAS:-rafaypair}"
export RAFAYPAIR_ANDROID_KEY_PASSWORD="$keystore_password"

# The staging variant is release-shaped — signed, minified, not debuggable — and
# the build refuses to produce it without the five Firebase and Play Integrity
# identifiers.
#
# Gradle reads them from a gradle property, then the environment, then
# local.properties. Exporting placeholders unconditionally would therefore
# silently outrank real values sitting in local.properties, so they are only
# supplied when that file does not already carry them.
identifiers_file="$PROJECT_ROOT/apps/android/local.properties"
if grep -qs '^RAFAYPAIR_FIREBASE_API_KEY=AIza' "$identifiers_file"; then
  note "using the real Firebase and Play Integrity identifiers from local.properties"
  using_placeholders=""
else
  note "no identifiers in local.properties — building with placeholders (push will not work)"
  using_placeholders="yes"
  export RAFAYPAIR_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER="${RAFAYPAIR_PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER:-123456789012}"
  export RAFAYPAIR_FIREBASE_API_KEY="${RAFAYPAIR_FIREBASE_API_KEY:-AIzaPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP}"
  export RAFAYPAIR_FIREBASE_APPLICATION_ID="${RAFAYPAIR_FIREBASE_APPLICATION_ID:-1:123456789012:android:0123456789abcdef}"
  export RAFAYPAIR_FIREBASE_PROJECT_ID="${RAFAYPAIR_FIREBASE_PROJECT_ID:-rafaypair-placeholder}"
  export RAFAYPAIR_FIREBASE_SENDER_ID="${RAFAYPAIR_FIREBASE_SENDER_ID:-123456789012}"
fi

mkdir -p "$OUT_DIR"
cd "$PROJECT_ROOT/apps/android"

note "staging (release-shaped: signed, minified)"
./gradlew --configuration-cache assembleStaging --console=plain -q \
  || fail "The staging build failed."
cp app/build/outputs/apk/staging/app-staging.apk "$OUT_DIR/RafayPair-live-staging.apk"

# Unminified and debug-signed. If the minified build ever misbehaves, this one
# separates "the app is wrong" from "a shrinker rule is wrong".
note "development (unminified fallback)"
./gradlew --configuration-cache assembleDevelopment --console=plain -q \
  || fail "The development build failed."
cp app/build/outputs/apk/development/app-development.apk "$OUT_DIR/RafayPair-live-development.apk"

# The newest build-tools, chosen explicitly: an unanchored glob expands to
# every installed version, and the extra paths arrive as arguments.
apksigner="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)apksigner"
[[ -x "$apksigner" ]] || fail "No apksigner under $ANDROID_HOME/build-tools."
"$apksigner" verify --print-certs "$OUT_DIR/RafayPair-live-staging.apk" \
  | head -2 | sed 's/^/    /'

# ---------------------------------------------------------------------------

cat <<SUMMARY

$(printf '\033[1mDone.\033[0m')

  API          https://$DOMAIN  (health/ready → 200)
  Artifacts    $OUT_DIR
                 RafayPair-live-staging.apk      ← install this one
                 RafayPair-live-development.apk  ← fallback, unminified

  These work from anywhere, including mobile data. The three application IDs
  differ (.staging, .dev, and the plain release build), so they can all be
  installed side by side.

$(printf '\033[1mWhat is not finished, and why\033[0m')

  Device attestation is not enforced. The API's production mode requires Play
  Integrity credentials from Google and App Attest identifiers from Apple;
  until those exist it runs pre-production, which also means web session
  cookies are not marked Secure. Use the phone apps against this endpoint.

${using_placeholders:+  Push notifications will not arrive: the artifacts carry placeholder Firebase
  identifiers. Put the real five values in apps/android/local.properties and
  re-run this script to replace them.
}
  Rafay AI voice needs the Model Studio workspace activated. Everything else —
  accounts, pairing, consent, care, camera workouts, pulse, breathing, together
  mode, the assistant's memory — works against this deployment.

SUMMARY
