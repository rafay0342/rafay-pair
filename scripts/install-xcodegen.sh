#!/usr/bin/env bash
set -euo pipefail

version="2.46.0"
archive_sha256="4d9e34b62172d645eed6457cac13fc222569974098ef4ee9c3368bedf0196806"
install_root="${XCODEGEN_INSTALL_DIR:?XCODEGEN_INSTALL_DIR is required}"
download_url="https://github.com/yonaskolb/XcodeGen/releases/download/$version/xcodegen.zip"

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
archive_path="$temporary_directory/xcodegen.zip"

curl --fail --location --silent --show-error \
  --retry 3 --retry-all-errors \
  "$download_url" --output "$archive_path"
printf '%s  %s\n' "$archive_sha256" "$archive_path" | shasum -a 256 --check --status
unzip -q "$archive_path" -d "$temporary_directory/extracted"

mkdir -p "$install_root/bin" "$install_root/share"
install -m 0755 "$temporary_directory/extracted/xcodegen/bin/xcodegen" "$install_root/bin/xcodegen"
cp -R "$temporary_directory/extracted/xcodegen/share/xcodegen" "$install_root/share/xcodegen"

installed_version="$("$install_root/bin/xcodegen" --version)"
test "$installed_version" = "Version: $version"
echo "Installed XcodeGen $version at $install_root."
