#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
apple_team_id="${APPLE_TEAM_ID:?APPLE_TEAM_ID is required for a signed iOS archive}"
configuration="${IOS_CONFIGURATION:-Release}"
export_kind="${IOS_EXPORT_KIND:-app-store}"
build_number="${IOS_BUILD_NUMBER:-}"
artifact_root="${ARTIFACT_ROOT:-$project_root/artifacts/ios}"
archive_path="$artifact_root/RafayPair.xcarchive"
export_path="$artifact_root/export"

case "$export_kind" in
  development) export_template="$project_root/apps/ios/Config/ExportOptions-Development.plist" ;;
  app-store) export_template="$project_root/apps/ios/Config/ExportOptions-AppStore.plist" ;;
  *) echo "IOS_EXPORT_KIND must be development or app-store." >&2; exit 1 ;;
esac

if [[ -n "$build_number" ]]; then
  if [[ ! "$build_number" =~ ^[1-9][0-9]*$ ]] || [[ "${#build_number}" -gt 10 ]] || ((10#$build_number > 2147483647)); then
    echo "IOS_BUILD_NUMBER must be an integer from 1 through 2147483647." >&2
    exit 1
  fi
fi

mkdir -p "$artifact_root"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
export_options="$temporary_directory/ExportOptions.plist"
cp "$export_template" "$export_options"
/usr/libexec/PlistBuddy -c "Add :teamID string $apple_team_id" "$export_options"

cd "$project_root/apps/ios"
xcodegen generate

authentication_flags=()
if [[ -n "${APP_STORE_CONNECT_KEY_PATH:-}" ]]; then
  authentication_flags+=(
    -allowProvisioningUpdates
    -authenticationKeyPath "$APP_STORE_CONNECT_KEY_PATH"
    -authenticationKeyID "${APP_STORE_CONNECT_KEY_ID:?APP_STORE_CONNECT_KEY_ID is required}"
    -authenticationKeyIssuerID "${APP_STORE_CONNECT_ISSUER_ID:?APP_STORE_CONNECT_ISSUER_ID is required}"
  )
fi

build_number_flags=()
if [[ -n "$build_number" ]]; then
  build_number_flags+=(CURRENT_PROJECT_VERSION="$build_number")
fi

xcodebuild \
  -project RafayPair.xcodeproj \
  -scheme RafayPair \
  -configuration "$configuration" \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  DEVELOPMENT_TEAM="$apple_team_id" \
  CODE_SIGN_STYLE=Automatic \
  "${build_number_flags[@]}" \
  "${authentication_flags[@]}" \
  clean archive

xcodebuild \
  -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist "$export_options" \
  "${authentication_flags[@]}"

test -n "$(find "$export_path" -maxdepth 1 -name '*.ipa' -print -quit)"
echo "Signed iOS archive and IPA exported to $artifact_root."
