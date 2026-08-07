#!/usr/bin/env bash
set -euo pipefail

# Builds and installs RafayPair on a real iPhone.
#
# Signing uses Xcode's automatic mode with a personal Apple ID, which is enough
# for development installs and needs no paid membership. The team identifier is
# read from, in order: RAFAYPAIR_DEVELOPMENT_TEAM, apps/ios/Config/Local.xcconfig,
# or whatever single team the Xcode account already has.

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ios_root="$project_root/apps/ios"
local_config="$ios_root/Config/Local.xcconfig"

team="${RAFAYPAIR_DEVELOPMENT_TEAM:-}"
if [ -z "$team" ] && [ -f "$local_config" ]; then
  team="$(sed -n 's/^DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*//p' "$local_config" | tr -d '[:space:]')"
fi

if [ -z "$team" ]; then
  cat >&2 <<'GUIDE'
No Apple development team is configured yet.

One-time setup, all free — no paid Apple Developer membership is needed for
installing on your own phone:

  1. Open Xcode → Settings (Cmd+,) → Accounts.
  2. If your Apple ID is listed but greyed out or erroring, select it and press
     the minus button to remove it, then add it again with the plus button.
     (The command line cannot read a half-signed-in account, which is what a
     "missing Xcode-Username" error means.)
  3. Select the account, click "Manage Certificates…", press "+" and choose
     "Apple Development". Close the dialog.
  4. Still on the Accounts screen, note the 10-character Team ID shown next to
     your name — something like A1B2C3D4E5.

Then either export it:

  export RAFAYPAIR_DEVELOPMENT_TEAM=A1B2C3D4E5

or write it once into apps/ios/Config/Local.xcconfig (git-ignored):

  echo 'DEVELOPMENT_TEAM = A1B2C3D4E5' > apps/ios/Config/Local.xcconfig

and run this script again.
GUIDE
  exit 1
fi

cd "$ios_root"
if command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate
fi

echo "Building for a real device with team $team…"
xcodebuild \
  -project RafayPair.xcodeproj \
  -scheme RafayPair \
  -configuration Development \
  -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$team" \
  build

# `devicectl` reports every paired device; only a connected, unlocked, trusted
# one can actually receive an install.
device_id="$(xcrun devicectl list devices 2>/dev/null \
  | awk '$0 ~ /connected|available/ && $0 !~ /unavailable/ {print $(NF-3)}' \
  | head -1)"

if [ -z "$device_id" ]; then
  cat >&2 <<'GUIDE'

The app built and signed, but no iPhone is currently available to install onto.

  - Connect the iPhone by cable.
  - Unlock it and leave it on the home screen.
  - If a "Trust This Computer?" prompt appears, tap Trust.
  - On the phone, Settings → Privacy & Security → Developer Mode must be on.

Then run this script again; the build is cached, so it will be quick.
GUIDE
  exit 0
fi

app_path="$(xcodebuild -project RafayPair.xcodeproj -scheme RafayPair \
  -configuration Development -destination 'generic/platform=iOS' \
  -showBuildSettings 2>/dev/null \
  | awk -F' = ' '/ BUILT_PRODUCTS_DIR /{print $2; exit}')/RafayPair.app"

echo "Installing $app_path onto $device_id…"
xcrun devicectl device install app --device "$device_id" "$app_path"

cat <<'GUIDE'

Installed. The first launch will be blocked until you trust the developer:

  On the iPhone: Settings → General → VPN & Device Management →
  tap your Apple ID under "Developer App" → Trust.

A personal-team build expires after seven days; re-run this script to renew it.
GUIDE
