#!/bin/bash

set -euo pipefail

REPOSITORY_ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
WORKFLOW="$REPOSITORY_ROOT/.github/workflows/upstream-signed-ios.yml"
PROCESSOR="$REPOSITORY_ROOT/Services/UDIDOnboarding/automation/process-device.mjs"

require_pattern() {
    local pattern="$1"
    local file="$2"
    local description="$3"
    if ! grep -Eq "$pattern" "$file"; then
        echo "Missing workflow requirement: $description" >&2
        exit 1
    fi
}

require_pattern 'onboarding_request_id:' "$WORKFLOW" "opaque onboarding input"
require_pattern 'UDID_WORKER_URL' "$WORKFLOW" "private Worker URL"
require_pattern '/claim' "$WORKFLOW" "single-use CMS claim"
require_pattern 'verify-cms\.sh' "$WORKFLOW" "CMS signature verification"
require_pattern 'process-device\.mjs' "$WORKFLOW" "Apple device provisioning"
require_pattern 'IOS_PROVISIONING_PROFILE_BASE64' "$WORKFLOW" "static profile fallback"
require_pattern 'openssl pkcs12 -legacy .* -clcerts -nokeys' "$WORKFLOW" "legacy-compatible leaf certificate extraction from the signing P12"
require_pattern 'CERTIFICATE_SHA=.*openssl x509 .* -fingerprint -sha1' "$WORKFLOW" "imported signing identity fingerprint verification"
require_pattern 'if: always\(\)' "$WORKFLOW" "terminal status reporting"
require_pattern '/status' "$WORKFLOW" "Worker status callback"
require_pattern '::add-mask::' "$PROCESSOR" "device identifier masking"

if grep -Eq '^[[:space:]]+udid:' "$WORKFLOW"; then
    echo "Workflow must not expose a UDID input" >&2
    exit 1
fi

if grep -Fq "security find-certificate -Z \"\${IDENTITY_SHA}\"" "$WORKFLOW"; then
    echo "Workflow must not pass a fingerprint as security find-certificate's keychain argument" >&2
    exit 1
fi

echo "workflow privacy checks passed"
