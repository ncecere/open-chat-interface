#!/usr/bin/env bash
# OCI scale harness: builds the images from this checkout, starts its own
# compose project (oci-scale), migrates, generates a dataset, warms up, runs
# the k6 scenarios, collects measurements, writes a report and tears down only
# its own project. See docs/dev/scale-harness.md.
#
#   tools/scale/run.sh --profile small [--replicas 2] [--enforce] [--keep]
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/scale/run.sh [options]

  --profile NAME     tiny | small | medium | large (default: tiny)
  --replicas N       API replicas behind the web proxy (default: 1)
  --enforce          exit non-zero when a target or error threshold is missed
  --keep             leave the stack and its data running afterwards
  --no-build         use existing images (SCALE_API_IMAGE / SCALE_WEB_IMAGE)
  --no-generate      reuse the data of a previous --keep run
  --skip-retention   skip the (destructive) retention phase
  --seed TEXT        dataset seed (default: oci-scale)
  --dimensions N     embedding dimensions (default: 1536)
  --results DIR      where results go (default: tools/scale/results)
  -h, --help         this help

Environment: SCALE_WEB_PORT (18080), SCALE_PG_PORT (15432), SCALE_STUB_PORT
(14181), STUB_FIRST_TOKEN_MS (500), STUB_TOKENS_PER_SECOND (50),
STUB_REPLY_TOKENS (250), SCALE_PG_SHARED_BUFFERS (1GB), SCALE_PROJECT (oci-scale).
EOF
}

PROFILE=tiny
REPLICAS=1
ENFORCE=0
KEEP=0
BUILD=1
GENERATE=1
RETENTION=1
SEED=oci-scale
DIMENSIONS=1536
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RESULTS="$HERE/results"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --replicas) REPLICAS="$2"; shift 2 ;;
    --enforce) ENFORCE=1; shift ;;
    --keep) KEEP=1; shift ;;
    --no-build) BUILD=0; shift ;;
    --no-generate) GENERATE=0; shift ;;
    --skip-retention) RETENTION=0; shift ;;
    --seed) SEED="$2"; shift 2 ;;
    --dimensions) DIMENSIONS="$2"; shift 2 ;;
    --results) RESULTS="$2"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PROFILE" in tiny | small | medium | large) ;; *) echo "Unknown profile: $PROFILE" >&2; exit 2 ;; esac
[[ "$REPLICAS" =~ ^[1-9][0-9]*$ ]] || { echo "--replicas must be a positive integer" >&2; exit 2; }

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

export SCALE_PROJECT="${SCALE_PROJECT:-oci-scale}"
export SCALE_API_IMAGE="${SCALE_API_IMAGE:-oci-scale-api:local}"
export SCALE_WEB_IMAGE="${SCALE_WEB_IMAGE:-oci-scale-web:local}"
export SCALE_WEB_PORT="${SCALE_WEB_PORT:-18080}"
export SCALE_APP_URL="http://127.0.0.1:${SCALE_WEB_PORT}"
SCALE_UID="$(id -u)"
SCALE_GID="$(id -g)"
export SCALE_UID SCALE_GID
export SCALE_PROFILE="$PROFILE"
export SCALE_API_REPLICAS="$REPLICAS"
export STUB_FIRST_TOKEN_MS="${STUB_FIRST_TOKEN_MS:-500}"
export STUB_TOKENS_PER_SECOND="${STUB_TOKENS_PER_SECOND:-50}"
export STUB_REPLY_TOKENS="${STUB_REPLY_TOKENS:-250}"
# Per-run secrets for a disposable stack.
random_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
SCALE_AUTH_SECRET="$(random_hex 32)"
SCALE_ENCRYPTION_KEY="$(random_hex 32)"
SCALE_METRICS_TOKEN="$(random_hex 24)"
export SCALE_AUTH_SECRET SCALE_ENCRYPTION_KEY SCALE_METRICS_TOKEN

DATE="$(date -u +%Y-%m-%d)"
export SCALE_DATE="$DATE"
RUN_NAME="${PROFILE}-${DATE}"
RUN_DIR="$RESULTS/$RUN_NAME"
mkdir -p "$RUN_DIR"
export SCALE_RESULTS_DIR="$RUN_DIR"

compose() { docker compose -p "$SCALE_PROJECT" -f "$HERE/compose.yaml" "$@"; }
psql_scale() { compose exec -T postgres psql -U oci -d oci -v ON_ERROR_STOP=1 -qAt "$@"; }

teardown() {
  local status=$?
  if [[ "$KEEP" == 1 ]]; then
    log "Leaving project $SCALE_PROJECT running (--keep). Remove it with: docker compose -p $SCALE_PROJECT -f $HERE/compose.yaml down -v"
  else
    log "Tearing down project $SCALE_PROJECT (containers and its own volumes only)"
    compose --profile tools down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}

# --- Preflight -----------------------------------------------------------------
docker info >/dev/null 2>&1 || { echo "Docker is not available" >&2; exit 1; }

if [[ "$(uname)" == Darwin ]]; then
  HW_CPU="$(sysctl -n machdep.cpu.brand_string)"
  HW_MEMORY="$(( $(sysctl -n hw.memsize) / 1073741824 )) GiB"
  HW_OS="macOS $(sw_vers -productVersion)"
else
  HW_CPU="$(lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | head -1)"
  HW_CPU="${HW_CPU:-$(uname -m)}, $(nproc) CPUs"
  HW_MEMORY="$(awk '/MemTotal/ {printf "%d GiB", $2/1048576}' /proc/meminfo)"
  HW_OS="$(uname -sr)"
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    HW_OS="$(. /etc/os-release && echo "$PRETTY_NAME")"
  fi
fi
export SCALE_HW_CPU="$HW_CPU" SCALE_HW_MEMORY="$HW_MEMORY" SCALE_HW_OS="$HW_OS"
SCALE_DOCKER_CPUS="$(docker info --format '{{.NCPU}}')"
SCALE_DOCKER_MEMORY="$(( $(docker info --format '{{.MemTotal}}') / 1073741824 )) GiB"
SCALE_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)$(git -C "$ROOT" diff --quiet HEAD -- apps packages 2>/dev/null || echo '+changes')"
export SCALE_DOCKER_CPUS SCALE_DOCKER_MEMORY SCALE_COMMIT
log "Profile $PROFILE, $REPLICAS API replica(s); $HW_CPU, $HW_MEMORY; Docker $SCALE_DOCKER_CPUS CPUs, $SCALE_DOCKER_MEMORY"

# Free space where Docker keeps volumes (inside the VM on Docker Desktop).
NEEDED_GB="$(sed -n "/^  $PROFILE: {/,/^  [a-z]*: {/p" "$HERE/profiles.mjs" | sed -n 's/.*estimatedGigabytes: \([0-9.]*\).*/\1/p' | head -1)"
FREE_KB="$(docker run --rm --entrypoint df "${SCALE_POSTGRES_IMAGE:-pgvector/pgvector:pg17}" -Pk / | awk 'NR==2 {print $4}')"
FREE_GB=$(( FREE_KB / 1048576 ))
# Data, WAL (max_wal_size 8GB) and index-build space: 1.5 times the data plus 10 GB.
if awk -v free="$FREE_GB" -v need="${NEEDED_GB:-1}" 'BEGIN { exit !(free < need * 1.5 + 10) }'; then
  echo "Not enough disk for $PROFILE: about ${NEEDED_GB} GB of data needs $(awk -v n="$NEEDED_GB" 'BEGIN{print n*1.5+10}') GB free; Docker has ${FREE_GB} GB." >&2
  exit 1
fi
log "Docker disk: ${FREE_GB} GB free; $PROFILE needs about ${NEEDED_GB} GB"

trap teardown EXIT

# --- Images --------------------------------------------------------------------
if [[ "$BUILD" == 1 ]]; then
  log "Building $SCALE_API_IMAGE and $SCALE_WEB_IMAGE from $ROOT"
  docker build -q -f "$ROOT/docker/api.Dockerfile" -t "$SCALE_API_IMAGE" "$ROOT" >/dev/null
  docker build -q -f "$ROOT/docker/web.Dockerfile" -t "$SCALE_WEB_IMAGE" "$ROOT" >/dev/null
fi

# --- Database, dataset ----------------------------------------------------------
log "Starting PostgreSQL, Redis and the stub model"
compose up -d --wait postgres redis stub >/dev/null
psql_scale -c 'create extension if not exists pg_stat_statements' >/dev/null

if [[ "$GENERATE" == 1 ]]; then
  log "Migrating"
  compose --profile tools run --rm migrate >/dev/null
  log "Generating the $PROFILE dataset"
  compose --profile tools run --rm tools /scale/generate.mjs --profile "$PROFILE" \
    --seed "$SEED" --dimensions "$DIMENSIONS" --out /results --reset
else
  [[ -f "$RUN_DIR/fixtures.json" ]] || { echo "--no-generate needs $RUN_DIR/fixtures.json from an earlier run" >&2; exit 1; }
fi

# Retention windows that prune about the oldest quarter (used by the last phase only).
retention_days() { sed -n "s/.*\"$1\": \([0-9]*\).*/\1/p" "$RUN_DIR/generate.json" | tail -1; }
SCALE_RETENTION_USAGE_DAYS="$(retention_days usageEvents)"
SCALE_RETENTION_AUDIT_DAYS="$(retention_days auditLog)"
export SCALE_RETENTION_USAGE_DAYS SCALE_RETENTION_AUDIT_DAYS

# --- Application ---------------------------------------------------------------
log "Starting $REPLICAS API replica(s) and the web proxy"
compose up -d --wait --scale "api=$REPLICAS" api web >/dev/null

run_k6() {
  local phase="$1" script="$2"
  compose --profile tools run --rm -e SCALE_PROFILE="$PROFILE" -e SCALE_PHASE="$phase" k6 run --quiet "/scale/k6/$script"
}

log "Warming up (not measured)"
run_k6 warm main.js >/dev/null 2>&1 || true
psql_scale -c 'select pg_stat_statements_reset()' >/dev/null
compose --profile tools run --rm tools /scale/report.mjs snapshot --name before >/dev/null

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Main run: sign-in storm, then mixed load"
set +e
run_k6 main main.js
K6_STATUS=$?
set -e
case "$K6_STATUS" in
  0) log "All thresholds met" ;;
  99) log "Some thresholds were missed (reported; use --enforce to fail on them)" ;;
  *) log "k6 failed with status $K6_STATUS"; exit "$K6_STATUS" ;;
esac
compose --profile tools run --rm tools /scale/report.mjs collect --phase main --since "$STARTED"

if [[ "$RETENTION" == 1 ]]; then
  log "Retention phase (usage events older than ${SCALE_RETENTION_USAGE_DAYS} days, audit entries older than ${SCALE_RETENTION_AUDIT_DAYS} days)"
  run_k6 retention retention.js || true
  compose --profile tools run --rm tools /scale/report.mjs collect --phase retention --since "$STARTED" >/dev/null
fi

compose --profile tools run --rm \
  -e SCALE_COMMIT -e SCALE_DATE -e SCALE_HW_CPU -e SCALE_HW_MEMORY -e SCALE_HW_OS \
  -e SCALE_DOCKER_CPUS -e SCALE_DOCKER_MEMORY -e SCALE_API_REPLICAS -e SCALE_PROFILE \
  -e STUB_FIRST_TOKEN_MS -e STUB_TOKENS_PER_SECOND -e STUB_REPLY_TOKENS \
  tools /scale/report.mjs render >/dev/null
cp "$RUN_DIR/report.md" "$RESULTS/$RUN_NAME.md"
cp "$RUN_DIR/report.json" "$RESULTS/$RUN_NAME.json"
log "Report: $RESULTS/$RUN_NAME.md (raw files in $RUN_DIR)"

if [[ "$ENFORCE" == 1 && "$K6_STATUS" == 99 ]]; then
  log "Failing because thresholds were missed (--enforce)"
  exit 1
fi
