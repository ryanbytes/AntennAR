#!/usr/bin/env bash
set -euo pipefail

if [[ ! -d dist ]]; then
  echo "Run npm run build before deploying." >&2
  exit 1
fi
if [[ -z "${ANTENNAR_DEPLOY_TARGET:-}" ]]; then
  echo "Set ANTENNAR_DEPLOY_TARGET (for example, root@your-vps)." >&2
  exit 1
fi

rsync -a --delete dist/ "${ANTENNAR_DEPLOY_TARGET}:/var/www/antennar.ftnsa.com/"
