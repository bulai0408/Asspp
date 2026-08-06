#!/bin/bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "Usage: verify-cms.sh <callback.der> <attributes.json>" >&2
    exit 2
fi

INPUT_PATH="$1"
OUTPUT_PATH="$2"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
CA_FILE="${APPLE_DEVICE_CA_FILE:-$SCRIPT_DIR/certs/apple-iphone-device-ca.pem}"
OPENSSL_BIN="${OPENSSL_BIN:-openssl}"
MAX_CMS_BYTES=$((256 * 1024))

if [ ! -f "$INPUT_PATH" ] || [ ! -f "$CA_FILE" ]; then
    echo "CMS input or trust anchor is missing" >&2
    exit 1
fi

CMS_SIZE=$(stat -f %z "$INPUT_PATH" 2>/dev/null || stat -c %s "$INPUT_PATH")
if [ "$CMS_SIZE" -le 0 ] || [ "$CMS_SIZE" -gt "$MAX_CMS_BYTES" ]; then
    echo "CMS input size is invalid" >&2
    exit 1
fi

if ! command -v "$OPENSSL_BIN" >/dev/null 2>&1; then
    echo "OpenSSL is unavailable" >&2
    exit 1
fi

TEMP_DIR=$(mktemp -d)
cleanup() {
    rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

PLIST_PATH="$TEMP_DIR/attributes.plist"
VERIFY_LOG="$TEMP_DIR/verify.log"

if ! "$OPENSSL_BIN" cms -verify \
    -binary \
    -inform DER \
    -in "$INPUT_PATH" \
    -CAfile "$CA_FILE" \
    -partial_chain \
    -no_check_time \
    -purpose any \
    -out "$PLIST_PATH" \
    2>"$VERIFY_LOG"; then
    echo "CMS signature or Apple device certificate verification failed" >&2
    exit 1
fi

if ! plutil -lint "$PLIST_PATH" >/dev/null; then
    echo "CMS payload is not a property list" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUTPUT_PATH")"
plutil -convert json -o "$OUTPUT_PATH" "$PLIST_PATH"
chmod 600 "$OUTPUT_PATH"
