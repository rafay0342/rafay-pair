#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
report_path="${1:?usage: report-artifact-sizes.sh REPORT_PATH ARTIFACT...}"
shift

if [[ "$#" -eq 0 ]]; then
  echo "At least one artifact path is required." >&2
  exit 1
fi

mkdir -p "$(dirname "$report_path")"
printf 'artifact\tbytes\n' > "$report_path"

file_size() {
  local path="$1"
  if stat -f '%z' "$path" >/dev/null 2>&1; then
    stat -f '%z' "$path"
  else
    stat -c '%s' "$path"
  fi
}

artifact_size() {
  local target="$1"
  local total=0
  local size
  local file
  if [[ -f "$target" ]]; then
    file_size "$target"
    return
  fi
  while IFS= read -r -d '' file; do
    size="$(file_size "$file")"
    total=$((total + size))
  done < <(find "$target" -type f -print0)
  printf '%s\n' "$total"
}

for target in "$@"; do
  if [[ ! -e "$target" ]]; then
    echo "Artifact does not exist: $target" >&2
    exit 1
  fi
  if [[ "$target" == "$project_root"/* ]]; then
    label="${target#"$project_root"/}"
  else
    label="$target"
  fi
  bytes="$(artifact_size "$target")"
  printf '%s\t%s\n' "$label" "$bytes" >> "$report_path"
done

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '### Release artifact sizes\n\n'
    printf '| Artifact | Bytes |\n| --- | ---: |\n'
    tail -n +2 "$report_path" | while IFS=$'\t' read -r artifact bytes; do
      printf "| \`%s\` | %s |\n" "$artifact" "$bytes"
    done
    printf '\n'
  } >> "$GITHUB_STEP_SUMMARY"
fi

echo "Artifact size report written to $report_path."
