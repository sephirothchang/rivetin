#!/usr/bin/env bash
set -euo pipefail
# Run on the CloudTower VM as root. No other VM or vCenter operation is performed.
release_dir="$(cd "$(dirname "$0")/.." && pwd)"
: "${TOWER_IMAGE:?Set the already verified Tower server image}"
: "${TOWER_ORIGINS:?Set allowed HTTPS origins, comma separated}"
: "${RIVETIN_BASE:?Set RIVETIN_BASE to the existing dedicated installation directory}"
case "$RIVETIN_BASE" in /var/cache/appcache/rivetin) ;; *) echo 'Use the dedicated /var/cache/appcache/rivetin directory.' >&2; exit 1;; esac
code="$RIVETIN_BASE/releases/0.1.4"
data="$RIVETIN_BASE/data"
mkdir -p "$code" "$data" "$RIVETIN_BASE/backups"
if [ -e "$code/server/main.js" ]; then
  tar -czf "$RIVETIN_BASE/backups/code-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C "$code" .
fi
if [ -e "$data/framework/settings.json" ]; then
  tar -czf "$RIVETIN_BASE/backups/data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" -C "$data" .
fi
cp -a "$release_dir/server" "$release_dir/shared" "$release_dir/cli.mjs" "$release_dir/package.json" "$code/"
if [ -f "$release_dir/THIRD_PARTY_NOTICES.txt" ]; then cp -a "$release_dir/THIRD_PARTY_NOTICES.txt" "$code/"; fi
if [ -f "$release_dir/LICENSE" ]; then cp -a "$release_dir/LICENSE" "$code/"; fi
chown 1000:1000 "$data"
export CODE_PATH="$code" DATA_PATH="$data"
CODE_DIGEST="$(find "$code/server" -type f -name '*.js' -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1)"
export CODE_DIGEST
python3 - "$release_dir/deploy/rivetin.yaml" "$RIVETIN_BASE/installed.yaml" <<'PY'
import os,sys
text=open(sys.argv[1]).read()
for key in ['TOWER_IMAGE','TOWER_ORIGINS','CODE_PATH','DATA_PATH','CODE_DIGEST']:
 value=os.environ[key]
 if any(c in value for c in '\n\r\t\"\''): raise RuntimeError('Invalid deployment value')
 text=text.replace('${'+key+'}',value)
open(sys.argv[2],'w').write(text)
PY
if kubectl -n cloudtower-system get deployment rivetin >/dev/null 2>&1; then
  kubectl -n cloudtower-system get deployment rivetin -o yaml > "$RIVETIN_BASE/backups/deployment-$(date -u +%Y%m%dT%H%M%SZ).yaml"
fi
kubectl apply -f "$RIVETIN_BASE/installed.yaml"
kubectl -n cloudtower-system rollout status deployment/rivetin --timeout=90s
kubectl -n cloudtower-system exec deployment/rivetin -- node cli.mjs init --data /var/lib/rivetin
printf '%s\n' 'Backend ready. New installs start disabled; existing runtime state is retained. Register the Island, then manage plugins through Plugin Center.'
