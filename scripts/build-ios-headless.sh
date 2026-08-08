#!/usr/bin/env bash
set -euo pipefail

# Sign and export an iOS build over SSH, with no GUI at all.
#
# Signing reads a private key from the login keychain. Over SSH that keychain is
# locked, so Xcode's certificate creation fails with "Write permissions error" —
# which reads like a bug and is actually just a locked keychain. Unlocking it
# explicitly, and then telling it which tools may use the key, is the whole
# trick, and it is the same thing continuous-integration machines do.
#
# Your macOS login password is read here and used for two `security` calls. It
# is never written to disk, never echoed, and never passed to anything else.
# `set-key-partition-list` has no interactive form, so for that one call the
# password is an argument to a child process and is briefly visible to a
# `ps` running as you on this machine. If that matters more than the build does,
# use a Mac with a screen instead.
#
# A free personal team cannot sign Push Notifications or App Attest, so this
# builds against RafayPair-personal.entitlements, which declares neither. The
# result is signed for seven days.

TEAM_ID="${APPLE_TEAM_ID:-HPBV3NY87T}"
API_URL="${RAFAYPAIR_IOS_API_URL:-https://34-134-185-230.sslip.io}"
OUT_DIR="${RAFAYPAIR_OUT_DIR:-$HOME/Desktop/RafayPair-release}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${RAFAYPAIR_IOS_WORK_DIR:-$PROJECT_ROOT/artifacts/ios-personal}"
ENTITLEMENTS="RafayPair/Resources/RafayPair-personal.entitlements"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2; exit 1; }

[[ -f "$KEYCHAIN" ]] || fail "No login keychain at $KEYCHAIN."
[[ -t 0 ]] || fail "Run this from an interactive shell; it has to ask for your password."

step "Unlocking the login keychain"
printf '    macOS login password for %s: ' "$USER"
read -rs LOGIN_PASSWORD
printf '\n'
[[ -n "$LOGIN_PASSWORD" ]] || fail "No password entered."

security unlock-keychain -p "$LOGIN_PASSWORD" "$KEYCHAIN" \
  || fail "That password did not unlock the keychain."
note "unlocked"

# Make sure it is on the search list. It usually already is in the user domain
# even when an SSH session's own list shows only the system keychain, so this
# adds it only when it is genuinely absent — rewriting the list unnecessarily
# would be a change to the machine that outlives this build.
ORIGINAL_KEYCHAINS="$(security list-keychains -d user | sed 's/[",]//g' | xargs)"
if printf '%s' "$ORIGINAL_KEYCHAINS" | grep -qF "$KEYCHAIN"; then
  note "already on the search list; leaving it alone"
else
  restore_keychains() {
    # shellcheck disable=SC2086
    [[ -n "${ORIGINAL_KEYCHAINS:-}" ]] && security list-keychains -d user -s $ORIGINAL_KEYCHAINS || true
  }
  trap restore_keychains EXIT
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$KEYCHAIN" $ORIGINAL_KEYCHAINS
  note "added to the search list for this build, and restored afterwards"
fi

# Stop the keychain relocking mid-build on a long archive.
security set-keychain-settings -t 7200 -l "$KEYCHAIN"

step "Creating the signing certificate if it does not exist"
cd "$PROJECT_ROOT/apps/ios"
xcodegen generate >/dev/null

if security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "Apple Development"; then
  note "a certificate already exists"
else
  note "asking Xcode to create one"
  # A plain device build is enough to make Xcode issue the certificate and the
  # profile. It is expected to fail if no device is registered yet; the
  # certificate is the part that matters here.
  xcodebuild \
    -project RafayPair.xcodeproj \
    -scheme RafayPair \
    -configuration Debug \
    -destination 'generic/platform=iOS' \
    -allowProvisioningUpdates \
    DEVELOPMENT_TEAM="$TEAM_ID" \
    CODE_SIGN_STYLE=Automatic \
    CODE_SIGN_ENTITLEMENTS="$ENTITLEMENTS" \
    build >/dev/null 2>&1 || true

  security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "Apple Development" \
    || fail "Xcode did not create a certificate.
    A free personal team allows a small number of them; if you have hit the
    limit, revoke an old one at developer.apple.com/account/resources/certificates
    and run this again."
fi
note "$(security find-identity -v -p codesigning "$KEYCHAIN" | grep 'Apple Development' | head -1 | sed 's/^ *//')"

# Let codesign use the key without a GUI prompt. This is the step that turns
# "0 valid identities" in a headless shell into a usable one.
security set-key-partition-list \
  -S apple-tool:,apple:,codesign: -s -k "$LOGIN_PASSWORD" "$KEYCHAIN" >/dev/null 2>&1 \
  || note "could not set the partition list; continuing, codesign may prompt"
unset LOGIN_PASSWORD

step "Checking for a connected iPhone"
if xcrun devicectl list devices 2>/dev/null | grep -qi "connected"; then
  note "a device is connected"
else
  printf '    \033[33mNo connected device detected.\033[0m\n'
  note "A personal team's profile lists specific devices, so the phone has to be"
  note "plugged in and unlocked at least once. Continuing in case it is already"
  note "registered."
fi

step "Archiving"
mkdir -p "$WORK_DIR"
rm -rf "$WORK_DIR/RafayPair.xcarchive"
# Debug rather than Release: the Release archive runs a pre-build check that
# demands the audited production entitlements, which is exactly what a personal
# team cannot sign. Keeping that check intact matters more than the name.
xcodebuild \
  -project RafayPair.xcodeproj \
  -scheme RafayPair \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -archivePath "$WORK_DIR/RafayPair.xcarchive" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_ENTITLEMENTS="$ENTITLEMENTS" \
  RAFAYPAIR_API_BASE_URL="$(printf '%s' "$API_URL" | sed 's|://|:/$()/|')" \
  archive \
  || fail "The archive failed. If it mentions a provisioning profile, connect and
    unlock the iPhone so the device can be registered, then run this again."

step "Exporting"
export_options="$WORK_DIR/ExportOptions.plist"
cat > "$export_options" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>development</string>
    <key>teamID</key>
    <string>$TEAM_ID</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>stripSwiftSymbols</key>
    <true/>
    <key>compileBitcode</key>
    <false/>
</dict>
</plist>
PLIST

rm -rf "$WORK_DIR/export"
xcodebuild \
  -exportArchive \
  -archivePath "$WORK_DIR/RafayPair.xcarchive" \
  -exportPath "$WORK_DIR/export" \
  -exportOptionsPlist "$export_options" \
  -allowProvisioningUpdates \
  || fail "The export failed. The archive is still at $WORK_DIR/RafayPair.xcarchive."

ipa="$(find "$WORK_DIR/export" -maxdepth 1 -name '*.ipa' -print -quit)"
[[ -n "$ipa" ]] || fail "No .ipa was produced."
mkdir -p "$OUT_DIR"
cp "$ipa" "$OUT_DIR/RafayPair-personal.ipa"

step "What was signed"
codesign -dv --entitlements :- "$WORK_DIR/RafayPair.xcarchive/Products/Applications/RafayPair.app" 2>&1 \
  | grep -E "Authority|TeamIdentifier|aps-environment|appattest" | sed 's/^/    /' || true

cat <<SUMMARY

$(printf '\033[1mDone.\033[0m')

  IPA   $OUT_DIR/RafayPair-personal.ipa
  API   $API_URL

  Install with the iPhone connected:

    xcrun devicectl device install app --device <name> "$OUT_DIR/RafayPair-personal.ipa"

  Push notifications and App Attest are absent — a free personal team cannot
  sign either — and it stops working after seven days. Both go away with a paid
  Developer Program membership, after which scripts/archive-ios.sh produces the
  real signed IPA with those capabilities intact.

SUMMARY
