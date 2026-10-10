#!/usr/bin/env bash
# Starts the production build with settings for a single-machine load test.
# Rate limiting is off because every virtual user shares one IP address.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV=production
export ACCESS_TOKEN_SECRET="${ACCESS_TOKEN_SECRET:-$(openssl rand -hex 32)}"
export RATE_LIMIT_ENABLED=false
export ADMIT_RATE_PER_SEC="${ADMIT_RATE_PER_SEC:-150}"
export MAX_ACTIVE_SESSIONS="${MAX_ACTIVE_SESSIONS:-400}"
export ENABLE_SIMULATOR=false
export LOG_LEVEL=warn
exec node dist/server.js
