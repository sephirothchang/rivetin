#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
GO_BIN="${GO_BIN:-go}"
export GOFLAGS='' GOEXPERIMENT='' GOTOOLCHAIN='local'
export GOPATH="${GOPATH:-$PWD/.local/go-cache}" GOCACHE="${GOCACHE:-$PWD/.local/go-build}"
"$GO_BIN" mod download
"$GO_BIN" mod verify
node scripts/prepare.mjs --go "$GO_BIN"
mkdir -p release
for target_os in windows linux darwin; do
  for target_arch in amd64 arm64; do
    suffix=''
    if [ "$target_os" = windows ]; then suffix='.exe'; fi
    CGO_ENABLED=0 GOOS="$target_os" GOARCH="$target_arch" "$GO_BIN" build -trimpath -buildvcs=false -ldflags '-s -w -buildid=' -o "release/pluginkit-$target_os-$target_arch$suffix" .
  done
done
cp ../LICENSE release/LICENSE
cp payload/NOTICES.txt release/THIRD_PARTY_NOTICES.txt
if command -v sha256sum >/dev/null 2>&1; then
  (cd release && sha256sum pluginkit-*) > release/SHA256SUMS
elif command -v shasum >/dev/null 2>&1; then
  (cd release && shasum -a 256 pluginkit-*) > release/SHA256SUMS
else
  printf '%s\n' 'Build completed; install a SHA-256 tool on the build host to create SHA256SUMS.' >&2
  exit 1
fi
