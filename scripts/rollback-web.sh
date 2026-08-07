#!/usr/bin/env bash
set -euo pipefail

release_id="${RELEASE_ID:?RELEASE_ID is required}"
web_bucket="${WEB_BUCKET:?WEB_BUCKET is required}"
distribution_id="${CLOUDFRONT_DISTRIBUTION_ID:?CLOUDFRONT_DISTRIBUTION_ID is required}"

aws s3api head-object --bucket "$web_bucket" --key "releases/$release_id/index.html" >/dev/null

# Restore stable root files from the same immutable release. Hashed /assets
# are deliberately retained across releases, so the restored HTML and service
# worker can still fetch their exact prior dependencies.
aws s3 sync "s3://$web_bucket/releases/$release_id/" "s3://$web_bucket/" \
  --exclude 'index.html' --exclude 'service-worker.js' --exclude 'sw.js' \
  --exclude 'assets/*' --exclude '_headers' \
  --cache-control 'no-cache,must-revalidate' --only-show-errors

aws s3 cp "s3://$web_bucket/releases/$release_id/index.html" "s3://$web_bucket/index.html" \
  --copy-props REPLACE --cache-control 'no-cache,max-age=0,must-revalidate' \
  --content-type 'text/html' --metadata "release-id=$release_id" --only-show-errors

for worker in service-worker.js sw.js; do
  if aws s3api head-object --bucket "$web_bucket" --key "releases/$release_id/$worker" >/dev/null 2>&1; then
    aws s3 cp "s3://$web_bucket/releases/$release_id/$worker" "s3://$web_bucket/$worker" \
      --copy-props REPLACE --cache-control 'no-cache,no-store,must-revalidate' \
      --content-type 'application/javascript' --only-show-errors
  fi
done

invalidation_id="$(aws cloudfront create-invalidation --distribution-id "$distribution_id" --paths \
  '/index.html' '/service-worker.js' '/sw.js' '/manifest.webmanifest' \
  '/asset-integrity.json' '/favicon.png' '/pwa-*' '/robots.txt' \
  --query 'Invalidation.Id' --output text)"
test -n "$invalidation_id"
test "$invalidation_id" != "None"
aws cloudfront wait invalidation-completed \
  --distribution-id "$distribution_id" --id "$invalidation_id"
echo "Rolled Web back to release $release_id."
