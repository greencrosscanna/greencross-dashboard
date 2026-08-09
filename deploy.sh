#!/bin/bash
# deploy.sh — Sales app release script
# Usage: GX_NOTES="what changed" ./deploy.sh
# Requires .gx_deploy_secret in the repo root (gitignored).

set -euo pipefail

GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
SECRET_FILE=".gx_deploy_secret"

# Pull APP_VERSION from the single source of truth in index.html
VERSION=$(grep -o "const APP_VERSION = '[^']*'" index.html | grep -o "'[^']*'" | tr -d "'")
if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not read APP_VERSION from index.html" >&2
  exit 1
fi

# Require .gx_deploy_secret
if [[ ! -f "$SECRET_FILE" ]]; then
  echo "ERROR: $SECRET_FILE not found. Ask Sky for the shared deploy secret and place it here." >&2
  exit 1
fi

GX_NOTES="${GX_NOTES:-}"
SHA=$(git rev-parse --short HEAD)

echo "==> Deploying Sales ${VERSION} (${SHA})"

# 1. Push backend to GAS (clasp push — does NOT cut a new version; only deploy does that)
echo "==> Pushing backend via clasp..."
bash clasp.sh push

# 2. Push frontend to GitHub Pages
echo "==> Pushing frontend to GitHub..."
git push origin main

# 3. Record this deploy to GX Core
echo "==> Recording deploy to GX Core..."
RESPONSE=$(curl -sL -G "$GXCORE" \
  --data-urlencode "action=deploy_version" \
  --data-urlencode "secret=$(cat "$SECRET_FILE")" \
  --data-urlencode "app=sales" \
  --data-urlencode "version=$VERSION" \
  --data-urlencode "sha=$SHA" \
  --data-urlencode "notes=$GX_NOTES")

echo "GX Core response: $RESPONSE"

# Verify the response contains a success indicator
if echo "$RESPONSE" | grep -qi '"ok":\s*true\|"status":\s*"ok"\|success'; then
  echo "==> Deploy recorded. ${VERSION} is live."
else
  echo "WARNING: GX Core response did not confirm success — check manually:" >&2
  echo "$RESPONSE" >&2
  echo "Verify: ${GXCORE}?action=version_history&app=sales"
fi
