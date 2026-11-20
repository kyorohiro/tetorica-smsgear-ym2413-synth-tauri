#!/bin/sh
set -eu
cd "$(dirname "$0")"

export CI=true
: "${APPLE_SIGNING_IDENTITY:?Set your local Developer ID Application identity}"
: "${APPLE_ID:?Set your Apple account email}"
: "${APPLE_TEAM_ID:?Set your Apple Developer Team ID}"
: "${APPLE_PASSWORD:?Set your app-specific notarization password}"
export APPLE_SIGNING_IDENTITY APPLE_ID APPLE_TEAM_ID APPLE_PASSWORD

npx tauri build --target x86_64-apple-darwin --bundles app,dmg -- --locked
npx tauri build --target aarch64-apple-darwin --bundles app,dmg -- --locked
