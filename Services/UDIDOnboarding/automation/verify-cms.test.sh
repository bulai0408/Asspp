#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TEST_DIR=$(mktemp -d)
cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$TEST_DIR/ca.key" \
    -out "$TEST_DIR/ca.pem" \
    -subj "/CN=Test Device CA" \
    -days 1 \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    >/dev/null 2>&1

openssl req -newkey rsa:2048 -nodes \
    -keyout "$TEST_DIR/device.key" \
    -out "$TEST_DIR/device.csr" \
    -subj "/CN=Test Device" \
    >/dev/null 2>&1

cat > "$TEST_DIR/device.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
EOF

openssl x509 -req \
    -in "$TEST_DIR/device.csr" \
    -CA "$TEST_DIR/ca.pem" \
    -CAkey "$TEST_DIR/ca.key" \
    -CAcreateserial \
    -out "$TEST_DIR/device.pem" \
    -days 1 \
    -extfile "$TEST_DIR/device.ext" \
    >/dev/null 2>&1

cat > "$TEST_DIR/attributes.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>UDID</key><string>00008120-0011223344556677</string>
  <key>CHALLENGE</key><string>synthetic-challenge</string>
</dict></plist>
EOF

openssl cms -sign \
    -binary \
    -in "$TEST_DIR/attributes.plist" \
    -signer "$TEST_DIR/device.pem" \
    -inkey "$TEST_DIR/device.key" \
    -certfile "$TEST_DIR/ca.pem" \
    -outform DER \
    -out "$TEST_DIR/callback.der" \
    -nodetach \
    >/dev/null 2>&1

APPLE_DEVICE_CA_FILE="$TEST_DIR/ca.pem" \
    "$SCRIPT_DIR/verify-cms.sh" "$TEST_DIR/callback.der" "$TEST_DIR/attributes.json"

plutil -extract UDID raw -o - "$TEST_DIR/attributes.json" | grep -q '^00008120-0011223344556677$'

cp "$TEST_DIR/callback.der" "$TEST_DIR/tampered.der"
printf '\x00' | dd of="$TEST_DIR/tampered.der" bs=1 seek=32 conv=notrunc status=none
if APPLE_DEVICE_CA_FILE="$TEST_DIR/ca.pem" \
    "$SCRIPT_DIR/verify-cms.sh" "$TEST_DIR/tampered.der" "$TEST_DIR/tampered.json" >/dev/null 2>&1; then
    echo "Tampered CMS was accepted" >&2
    exit 1
fi

echo "verify-cms tests passed"
