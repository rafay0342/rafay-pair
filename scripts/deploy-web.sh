#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_id="${RELEASE_ID:?RELEASE_ID is required}"
web_bucket="${WEB_BUCKET:?WEB_BUCKET is required}"
distribution_id="${CLOUDFRONT_DISTRIBUTION_ID:?CLOUDFRONT_DISTRIBUTION_ID is required}"
web_dist="$project_root/apps/web/dist"

test -f "$web_dist/index.html"
test -f "$web_dist/service-worker.js" || test -f "$web_dist/sw.js"

# Retain an immutable release copy for rollback and upload hashed assets first.
aws s3 sync "$web_dist" "s3://$web_bucket/releases/$release_id/" \
  --exclude 'index.html' --exclude 'service-worker.js' --exclude 'sw.js' \
  --cache-control 'public,max-age=31536000,immutable' --only-show-errors
aws s3 sync "$web_dist/assets" "s3://$web_bucket/assets" \
  --cache-control 'public,max-age=31536000,immutable' --only-show-errors

# Stable root assets (manifest, icons, robots and integrity metadata) are
# versioned under the release prefix above and refreshed without publishing
# host-specific deployment metadata such as _headers.
aws s3 sync "$web_dist" "s3://$web_bucket/" \
  --exclude 'index.html' --exclude 'service-worker.js' --exclude 'sw.js' \
  --exclude 'assets/*' --exclude '_headers' \
  --cache-control 'no-cache,must-revalidate' --only-show-errors

if [[ -f "$web_dist/service-worker.js" ]]; then
  aws s3 cp "$web_dist/service-worker.js" "s3://$web_bucket/releases/$release_id/service-worker.js" \
    --cache-control 'no-cache,no-store,must-revalidate' --content-type 'application/javascript' --only-show-errors
  aws s3 cp "$web_dist/service-worker.js" "s3://$web_bucket/service-worker.js" \
    --cache-control 'no-cache,no-store,must-revalidate' --content-type 'application/javascript' --only-show-errors
elif [[ -f "$web_dist/sw.js" ]]; then
  aws s3 cp "$web_dist/sw.js" "s3://$web_bucket/releases/$release_id/sw.js" \
    --cache-control 'no-cache,no-store,must-revalidate' --content-type 'application/javascript' --only-show-errors
  aws s3 cp "$web_dist/sw.js" "s3://$web_bucket/sw.js" \
    --cache-control 'no-cache,no-store,must-revalidate' --content-type 'application/javascript' --only-show-errors
fi

aws s3 cp "$web_dist/index.html" "s3://$web_bucket/releases/$release_id/index.html" \
  --cache-control 'no-cache,max-age=0,must-revalidate' --content-type 'text/html' --only-show-errors
# The HTML swap is last, so clients never see references to assets not already present.
aws s3 cp "$web_dist/index.html" "s3://$web_bucket/index.html" \
  --cache-control 'no-cache,max-age=0,must-revalidate' --content-type 'text/html' \
  --metadata "release-id=$release_id" --only-show-errors

invalidation_id="$(aws cloudfront create-invalidation --distribution-id "$distribution_id" --paths \
  '/index.html' '/service-worker.js' '/sw.js' '/manifest.webmanifest' \
  '/asset-integrity.json' '/favicon.png' '/pwa-*' '/robots.txt' \
  --query 'Invalidation.Id' --output text)"
test -n "$invalidation_id"
test "$invalidation_id" != "None"
aws cloudfront wait invalidation-completed \
  --distribution-id "$distribution_id" --id "$invalidation_id"
echo "Deployed Web release $release_id."
