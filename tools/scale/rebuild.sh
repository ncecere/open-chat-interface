#!/usr/bin/env bash
# Measures an embedding rebuild (v0.11 generations) on a stack left running by
# `run.sh --keep` (docs/dev/scale-harness.md, "Embedding generations"):
#
#   tools/scale/rebuild.sh --run-dir tools/scale/results/small-2026-10-04
#
# Gives the current embeddings generation a backlog again (so the
# `projects.embed-passages` job has work, as at the start of a run), saves
# another embeddings model as the generated administrator (which starts a
# rebuild into a new generation), and runs the main k6 phase while the
# rebuild fills; rebuild.mjs samples progress, the vector search statement
# and project-file uploads until searches switch. Results go to
# <run-dir>-rebuild/ (report.md and rebuild.json). Touches only the kept
# project's containers.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR=""
MODEL=scale-embed-2
BACKLOG=11000
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dir) RUN_DIR="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --backlog) BACKLOG="$2"; shift 2 ;;
    -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -f "$RUN_DIR/fixtures.json" ]] || { echo "--run-dir must be a kept run's directory (fixtures.json)" >&2; exit 2; }
[[ "$BACKLOG" =~ ^[0-9]+$ ]] || { echo "--backlog must be a number" >&2; exit 2; }

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
export SCALE_PROJECT="${SCALE_PROJECT:-oci-scale}"
export SCALE_API_IMAGE="${SCALE_API_IMAGE:-oci-scale-api:local}"
export SCALE_WEB_IMAGE="${SCALE_WEB_IMAGE:-oci-scale-web:local}"
compose() { docker compose -p "$SCALE_PROJECT" -f "$HERE/compose.yaml" "$@"; }
psql_scale() { compose exec -T postgres psql -U oci -d oci -v ON_ERROR_STOP=1 -qAt "$@"; }

API_CONTAINER="$(compose ps -q api | head -1)"
[[ -n "$API_CONTAINER" ]] || { echo "No running API in project $SCALE_PROJECT" >&2; exit 1; }
api_env() { docker inspect "$API_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n "s/^$1=//p"; }
SCALE_METRICS_TOKEN="$(api_env METRICS_TOKEN)"
SCALE_APP_URL="$(api_env APP_URL)"
SCALE_PROFILE="$(sed -n 's/.*"profile": "\([a-z]*\)".*/\1/p' "$RUN_DIR/generate.json" | head -1)"
SCALE_UID="$(id -u)"
SCALE_GID="$(id -g)"
OUT_DIR="${RUN_DIR%/}-rebuild"
mkdir -p "$OUT_DIR"
cp "$RUN_DIR/fixtures.json" "$RUN_DIR/generate.json" "$OUT_DIR/"
export SCALE_METRICS_TOKEN SCALE_APP_URL SCALE_PROFILE SCALE_UID SCALE_GID
export SCALE_RESULTS_DIR="$OUT_DIR"

TABLE="$(psql_scale -c "select table_name from embedding_generation where state = 'current'")"
[[ -n "$TABLE" ]] || TABLE=project_file_embedding
log "Removing $BACKLOG vectors from $TABLE, so the embedding job has a backlog"
psql_scale -c "delete from $TABLE where ctid in (select ctid from $TABLE order by random() limit $BACKLOG)" >/dev/null
psql_scale -c 'select pg_stat_statements_reset()' >/dev/null
compose --profile tools run --rm tools /scale/report.mjs snapshot --name before >/dev/null

log "Saving model $MODEL: the rebuild starts"
compose --profile tools run --rm -e SCALE_ORIGIN="$SCALE_APP_URL" tools /scale/rebuild.mjs \
  --model "$MODEL" --run-dir /results >"$OUT_DIR/rebuild.log" 2>&1 &
REBUILD_PID=$!
sleep 20

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Main k6 phase during the rebuild"
set +e
compose --profile tools run --rm -e SCALE_PROFILE="$SCALE_PROFILE" -e SCALE_PHASE=main k6 run --quiet /scale/k6/main.js >"$OUT_DIR/k6.log" 2>&1
K6_STATUS=$?
set -e
log "k6 finished with status $K6_STATUS"
compose --profile tools run --rm tools /scale/report.mjs collect --phase main --since "$STARTED" >/dev/null

log "Waiting for the rebuild to switch (rebuild.log)"
wait "$REBUILD_PID" || log "rebuild.mjs failed; see $OUT_DIR/rebuild.log"
compose --profile tools run --rm \
  -e SCALE_COMMIT -e SCALE_DATE -e SCALE_HW_CPU -e SCALE_HW_MEMORY -e SCALE_HW_OS \
  -e SCALE_DOCKER_CPUS -e SCALE_DOCKER_MEMORY -e SCALE_API_REPLICAS -e SCALE_PROFILE \
  tools /scale/report.mjs render >/dev/null || log "render failed"
log "Report: $OUT_DIR/report.md; rebuild: $OUT_DIR/rebuild.json"
