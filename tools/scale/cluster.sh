#!/usr/bin/env bash
# OCI scale harness on the bitop-talos cluster (docs/dev/scale-harness.md, "Large on the cluster").
# Creates a dev-env environment in namespace dev-oci, applies the harness's PostgreSQL settings,
# generates the dataset in cluster, runs the k6 phases of run.sh as one Job, copies the results to
# tools/scale/results/<profile>-cluster-<date>/ and removes everything it created.
#
#   tools/scale/cluster.sh --profile tiny --name scale-t1 --dry-run
#   tools/scale/cluster.sh --profile medium --name scale-m1 --db-node talos-cp-3
#
# Safe by construction: every kubectl call goes through k(), which asks lib/cluster-cli.mjs to add
# `-n dev-oci` and to refuse -A, --all-namespaces, any other namespace and anything that is not an
# object of this environment. Nothing here reads or writes production. A trap on EXIT, INT, TERM
# and HUP deletes the run Job (which stops the writes), runs `dev-env down` and checks that nothing
# labelled dev.bitop.dev/env=<name> is left. --dry-run prints every step and runs none of kubectl,
# helm, docker or dev-env. CI never runs this script.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/scale/cluster.sh --profile NAME --name ENV [options]

  --profile NAME      tiny | small | medium | large (default: tiny)
  --name ENV          the environment's name, 2-20 characters: lowercase letters, digits, dashes
  --ref REF           branch, tag or commit of the OCI clone (default: HEAD); its branch images
                      (dev-<sha12>) must be published
  --image-tag TAG     use this image tag instead of the one derived from --ref
  --db-node NODE      where the database volume lives: talos-cp-1 or talos-cp-3, never talos-cp-2.
                      Required for medium and large; tiny and small default to talos-cp-1. The load
                      side (API, web, worker, stub, k6) goes to the other one.
  --replicas N        API replicas (default 1; the worker is always 1)
  --ttl Nh            lifetime of the environment in whole hours (default: tiny 2, small 3,
                      medium 4, large 8); the Job stops 30 minutes before it
  --yes-large         required for large: it runs on the shared cluster
  --wait-backfill     start the load once background migrations have finished
                      (default: measure with whatever is still pending, and say so)
  --skip-retention    skip the (destructive) retention phase
  --seed TEXT         dataset seed (default: oci-scale)
  --dimensions N      embedding dimensions (default: 1536)
  --threshold K=V     force a watcher threshold, for the fire drill (repeatable), for example
                      etcdFsyncAbortOnceMs=0
  --etcd-metrics-cmd CMD   a command that prints etcd's own Prometheus metrics (default: the
                      apiserver's /metrics, whose request latency to etcd is a coarser signal)
  --window-seconds N  how long the preflight samples CPU and etcd (default: 60 tiny/small, 900 others)
  --preflight-only    read the cluster, print the preflight and stop; nothing is created
  --keep-on-abort     after a failure keep the environment until its TTL instead of removing it
  --results DIR       where results go (default: tools/scale/results)
  --dry-run           print every step; call none of kubectl, helm, docker, dev-env
  -h, --help          this help

Environment: DEVENV (the dev-env tool; default ~/homelab/bitop-talos/tools/dev-env/dev-env),
KUBECONFIG_DEV or KUBECONFIG (default <homelab>/kubeconfig), SCALE_KUBE_CONTEXT_PATTERN (a regular
expression the kubectl context must match; default bitop), SCALE_K6_IMAGE (default grafana/k6:1.3.0),
STUB_FIRST_TOKEN_MS, STUB_TOKENS_PER_SECOND, STUB_REPLY_TOKENS. Timings, for tests of this script
only: SCALE_INTERVAL_SECONDS (watcher and preflight sampling, 15), SCALE_POLL_SECONDS (following the
pod, 10), SCALE_VERIFY_WAIT_SECONDS (how long teardown verification retries, 180).

Start medium and large in the maintainer's quiet hours. Exit status: 0 done, 1 failed or aborted
(everything is torn down unless --keep-on-abort), 2 refused or misused.
EOF
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LIB="$HERE/lib"

PROFILE=tiny
NAME=""
REF=""
IMAGE_TAG=""
DB_NODE=""
REPLICAS=1
TTL=""
YES_LARGE=0
WAIT_BACKFILL=0
RETENTION=1
SEED=oci-scale
DIMENSIONS=1536
THRESHOLDS=()
ETCD_CMD=""
WINDOW=""
PREFLIGHT_ONLY=0
KEEP_ON_ABORT=0
DRY_RUN=0
RESULTS="$HERE/results"

die() { printf 'cluster.sh: %s\n' "$*" >&2; exit 1; }
usage_error() { printf 'cluster.sh: %s\n' "$*" >&2; usage >&2; exit 2; }
need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || usage_error "$1 needs a value"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) need_value "$@"; PROFILE="$2"; shift 2 ;;
    --name) need_value "$@"; NAME="$2"; shift 2 ;;
    --ref) need_value "$@"; REF="$2"; shift 2 ;;
    --image-tag) need_value "$@"; IMAGE_TAG="$2"; shift 2 ;;
    --db-node) need_value "$@"; DB_NODE="$2"; shift 2 ;;
    --replicas) need_value "$@"; REPLICAS="$2"; shift 2 ;;
    --ttl) need_value "$@"; TTL="$2"; shift 2 ;;
    --yes-large) YES_LARGE=1; shift ;;
    --wait-backfill) WAIT_BACKFILL=1; shift ;;
    --skip-retention) RETENTION=0; shift ;;
    --seed) need_value "$@"; SEED="$2"; shift 2 ;;
    --dimensions) need_value "$@"; DIMENSIONS="$2"; shift 2 ;;
    --threshold) need_value "$@"; THRESHOLDS+=("$2"); shift 2 ;;
    --etcd-metrics-cmd) need_value "$@"; ETCD_CMD="$2"; shift 2 ;;
    --window-seconds) need_value "$@"; WINDOW="$2"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --keep-on-abort) KEEP_ON_ABORT=1; shift ;;
    --results) need_value "$@"; RESULTS="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage_error "unknown option: $1" ;;
  esac
done

cli() { node "$LIB/cluster-cli.mjs" "$@"; }

# --- Arguments: everything refused here happens before anything else does -------------------------
case "$PROFILE" in tiny | small | medium | large) ;; *) usage_error "unknown profile: $PROFILE" ;; esac
[[ -n "$NAME" ]] || usage_error "--name is required"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{1,19}$ ]] || usage_error "--name must be 2-20 characters: lowercase letters, digits and dashes, starting with a letter"
# The chart names a release's objects <name>-open-chat-interface-*, unless the name already contains it.
[[ "$NAME" != *open-chat-interface* ]] || usage_error "--name must not contain open-chat-interface"
[[ "$REPLICAS" =~ ^[1-9][0-9]*$ ]] || usage_error "--replicas must be a positive integer"
[[ "$DIMENSIONS" =~ ^[1-9][0-9]*$ ]] || usage_error "--dimensions must be a positive integer"
[[ "$SEED" =~ ^[A-Za-z0-9._-]+$ ]] || usage_error "--seed may use letters, digits, dots, underscores and dashes only"
[[ -z "$WINDOW" || "$WINDOW" =~ ^[1-9][0-9]*$ ]] || usage_error "--window-seconds must be a positive integer"

if [[ "$PROFILE" == large && "$YES_LARGE" != 1 ]]; then
  printf 'cluster.sh: large runs on the shared cluster and writes about 75 GB; pass --yes-large to confirm\n' >&2
  exit 2
fi

PG_SIZE="$(cli plan "$PROFILE" pgSize)"
if [[ -z "$DB_NODE" ]]; then
  [[ "$(cli plan "$PROFILE" pinRequired)" != true ]] || usage_error "$PROFILE needs --db-node (talos-cp-1 or talos-cp-3)"
  DB_NODE=talos-cp-1
fi
cli pin --profile "$PROFILE" --node "$DB_NODE" || exit 2
if [[ "$DB_NODE" == talos-cp-1 ]]; then LOAD_NODE=talos-cp-3; else LOAD_NODE=talos-cp-1; fi

if [[ -n "$TTL" ]]; then
  [[ "$TTL" =~ ^([1-9][0-9]*)h$ ]] || usage_error "--ttl takes whole hours, such as 4h"
  TTL_HOURS="${BASH_REMATCH[1]}"
else
  TTL_HOURS="$(cli plan "$PROFILE" ttlHours)"
fi
DEADLINE_SECONDS="$(cli deadline "$TTL_HOURS")" || exit 2
if [[ ${#THRESHOLDS[@]} -gt 0 ]]; then
  cli overrides "${THRESHOLDS[@]}" > /dev/null || exit 2
fi

# --- Names and paths -----------------------------------------------------------------------------
HOMELAB="${SCALE_HOMELAB:-$HOME/homelab/bitop-talos}"
DEVENV="${DEVENV:-$HOMELAB/tools/dev-env/dev-env}"
KUBE="${KUBECONFIG_DEV:-${KUBECONFIG:-$HOMELAB/kubeconfig}}"
export SCALE_KUBECONFIG="$KUBE" KUBECONFIG_DEV="$KUBE"
CONTEXT_PATTERN="${SCALE_KUBE_CONTEXT_PATTERN:-bitop}"
K6_IMAGE="${SCALE_K6_IMAGE:-grafana/k6:1.3.0}"
STUB_FIRST_TOKEN_MS="${STUB_FIRST_TOKEN_MS:-500}"
STUB_TOKENS_PER_SECOND="${STUB_TOKENS_PER_SECOND:-50}"
STUB_REPLY_TOKENS="${STUB_REPLY_TOKENS:-250}"
INTERVAL="${SCALE_INTERVAL_SECONDS:-15}"
POLL="${SCALE_POLL_SECONDS:-10}"
VERIFY_WAIT="${SCALE_VERIFY_WAIT_SECONDS:-180}"
for timing in "$INTERVAL" "$POLL" "$VERIFY_WAIT"; do
  [[ "$timing" =~ ^[0-9]+(\.[0-9]+)?$ ]] || usage_error "SCALE_INTERVAL_SECONDS, SCALE_POLL_SECONDS and SCALE_VERIFY_WAIT_SECONDS must be numbers"
done

FULL="$NAME-open-chat-interface"
API="$FULL-api"
WORKER="$FULL-worker"
WEB="$FULL-web"
API_HEADLESS="$FULL-api-headless"
PG="$NAME-pg"
ENV_LABEL="dev.bitop.dev/env=$NAME"

DATE="$(date -u +%Y-%m-%d)"
RUN_NAME="${PROFILE}-cluster-${DATE}"
RUN_DIR="$RESULTS/$RUN_NAME"
COMMIT="$(git -C "$ROOT" rev-parse --short=12 HEAD 2> /dev/null || echo unknown)$(git -C "$ROOT" diff --quiet HEAD -- apps packages 2> /dev/null || echo '+changes')"
[[ -n "$REF" ]] || REF="${COMMIT%%+*}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ABORT_FILE="$WORK/watcher-abort.json"
WATCH_PID=""
UP_STARTED=0
POD=""
APP_URL=""
API_IMAGE=""
K_ARGS=()

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
step() { if [[ "$DRY_RUN" == 1 ]]; then printf '[dry-run] %s\n' "$*"; else log "$*"; fi; }

# --- The only ways to reach the cluster ----------------------------------------------------------
# Fills K_ARGS with the arguments for kubectl (the namespace first), or returns 2.
scope_args() {
  local scoped arg
  K_ARGS=()
  if ! scoped="$(cli scope --env "$NAME" -- "$@")"; then
    printf 'cluster.sh: refused: kubectl %s\n' "$*" >&2
    return 2
  fi
  while IFS= read -r arg; do K_ARGS+=("$arg"); done <<< "$scoped"
}

# kubectl, in dev-oci only. In a dry run it prints the call instead of making it.
k() {
  scope_args "$@" || exit 2
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '  + kubectl'
    printf ' %q' "${K_ARGS[@]}"
    printf '\n'
    return 0
  fi
  kubectl --kubeconfig "$KUBE" --request-timeout=60s "${K_ARGS[@]}"
}

# Like k, for a value that is captured: a dry run prints the call on stderr and answers with $1.
kq() {
  local default="$1"
  shift
  if [[ "$DRY_RUN" == 1 ]]; then
    scope_args "$@" || return 2
    {
      printf '  + kubectl'
      printf ' %q' "${K_ARGS[@]}"
      printf '\n'
    } >&2
    printf '%s\n' "$default"
    return 0
  fi
  k "$@"
}

devenv() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '  + dev-env %s\n' "$*"
    return 0
  fi
  "$DEVENV" "$@"
}

# A tool of this repo that reads the cluster itself, always through the same guard.
node_tool() {
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '  + node %s\n' "$*"
    return 0
  fi
  node "$LIB/$1" "${@:2}"
}

redact() { sed -E 's#postgres(ql)?://[^@[:space:]]*@#postgres://***@#g'; }
random_hex() { od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; }
bool() { if [[ "$1" == 1 ]]; then echo true; else echo false; fi; }

# --- Phases --------------------------------------------------------------------------------------
preflight() {
  step "Preflight (read-only): kubectl context, existing environments, node conditions, pool and disk on $DB_NODE, CPU on $DB_NODE and $LOAD_NODE, etcd health and latency"
  local -a extra=()
  if [[ -n "$WINDOW" ]]; then extra+=(--window-seconds "$WINDOW"); fi
  if [[ -n "$ETCD_CMD" ]]; then extra+=(--etcd-metrics-cmd "$ETCD_CMD"); fi
  if [[ "$DRY_RUN" != 1 ]]; then mkdir -p "$RUN_DIR"; fi
  node_tool cluster-preflight.mjs run --profile "$PROFILE" --name "$NAME" --db-node "$DB_NODE" --load-node "$LOAD_NODE" \
    --context-pattern "$CONTEXT_PATTERN" --interval-seconds "$INTERVAL" --dev-env "$DEVENV" --out "$RUN_DIR/preflight.json" "${extra[@]+"${extra[@]}"}"
}

need_pg_node() {
  step "Check that dev-env can pin the database (--pg-node, homelab commit 6fc60e9)"
  if [[ "$DRY_RUN" == 1 ]]; then
    devenv "up --help | grep -- --pg-node"
  else
    devenv up --help 2>&1 | grep -q -- '--pg-node' || die "this dev-env has no --pg-node: update the homelab checkout ($DEVENV)"
  fi
}

create_environment() {
  UP_STARTED=1
  step "Create the environment (database $PG_SIZE pinned to $DB_NODE, expires in ${TTL_HOURS}h); about a minute"
  local -a extra=()
  if [[ -n "$IMAGE_TAG" ]]; then extra+=(--image-tag "$IMAGE_TAG"); fi
  devenv up oci "$NAME" --ref "$REF" --ttl "${TTL_HOURS}h" --pg-size "$PG_SIZE" --pg-node "$DB_NODE" "${extra[@]+"${extra[@]}"}"
}

read_environment() {
  step "Read the environment's record (image tag, app address) and check the objects the run needs"
  local tag
  tag="$(kq dev-dryrun000000 get configmap "env-$NAME" -o 'jsonpath={.metadata.annotations.dev\.bitop\.dev/image-tag}')"
  APP_URL="$(kq http://localhost:18000 get configmap "env-$NAME" -o 'jsonpath={.metadata.annotations.dev\.bitop\.dev/app-url}')"
  [[ "$tag" =~ ^[A-Za-z0-9._-]+$ ]] || die "the environment record has no usable image tag ($tag)"
  [[ "$APP_URL" =~ ^https?://[A-Za-z0-9._:/-]+$ ]] || die "the environment record has no usable app address"
  API_IMAGE="ghcr.io/ncecere/open-chat-interface/api:$tag"
  local object
  for object in "deployment/$API" "deployment/$WORKER" "deployment/$WEB" "service/$PG-rw" "service/$API_HEADLESS" "secret/$PG-superuser"; do
    if ! kq "$object" get "$object" -o name > /dev/null 2>&1; then
      die "expected $object, which dev-env, the chart or CloudNativePG should have created (names differ from the convention; see docs/dev/scale-harness.md)"
    fi
  done
}

check_pin() {
  step "Check where the database volume landed (must be $DB_NODE, never talos-cp-2)"
  local pod_node pvc_node
  pod_node="$(kq "$DB_NODE" get pod "$PG-1" -o 'jsonpath={.spec.nodeName}')"
  cli pin --profile "$PROFILE" --node "$DB_NODE" --bound "$pod_node" --bound-check || die "the database is not where it was pinned"
  pvc_node="$(kq "$DB_NODE" get pvc "$PG-1" -o 'jsonpath={.metadata.annotations.volume\.kubernetes\.io/selected-node}' 2> /dev/null || true)"
  if [[ -n "$pvc_node" ]]; then
    cli pin --profile "$PROFILE" --node "$DB_NODE" --bound "$pvc_node" --bound-check || die "the volume's selected node is not the pinned one"
  else
    log "The claim has no selected-node annotation; the pod's node ($pod_node) is the evidence"
  fi
}

start_watcher() {
  step "Start the watcher (every 15 s: etcd latency and readiness, volume use, node conditions); it deletes the run Job and exits 3 past a threshold"
  local -a extra=()
  local threshold
  for threshold in "${THRESHOLDS[@]+"${THRESHOLDS[@]}"}"; do extra+=(--threshold "$threshold"); done
  if [[ -n "$ETCD_CMD" ]]; then extra+=(--etcd-metrics-cmd "$ETCD_CMD"); fi
  if [[ "$DRY_RUN" == 1 ]]; then
    node_tool cluster-watch.mjs --name "$NAME" --profile "$PROFILE" --db-node "$DB_NODE" --log "$RUN_DIR/watch.jsonl" --abort-file "$ABORT_FILE" --interval-seconds "$INTERVAL" "${extra[@]+"${extra[@]}"}" "&"
    return 0
  fi
  node "$LIB/cluster-watch.mjs" --name "$NAME" --profile "$PROFILE" --db-node "$DB_NODE" --log "$RUN_DIR/watch.jsonl" \
    --abort-file "$ABORT_FILE" --interval-seconds "$INTERVAL" "${extra[@]+"${extra[@]}"}" > "$RUN_DIR/watch.log" 2>&1 &
  WATCH_PID=$!
  local waited=0
  while [[ ! -s "$RUN_DIR/watch.jsonl" ]]; do
    kill -0 "$WATCH_PID" 2> /dev/null || die "the watcher stopped at start (see $RUN_DIR/watch.log); a run without a watcher is not allowed"
    [[ "$waited" -lt 120 ]] || die "the watcher took no sample in 2 minutes (see $RUN_DIR/watch.log)"
    sleep 2
    waited=$((waited + 2))
  done
  log "Watcher running (pid $WATCH_PID), log $RUN_DIR/watch.jsonl"
}

stop_watcher() {
  if [[ -n "$WATCH_PID" ]]; then
    kill "$WATCH_PID" 2> /dev/null || true
    wait "$WATCH_PID" 2> /dev/null || true
    WATCH_PID=""
  fi
}

# A watcher that aborted, or that is no longer running, stops the run.
check_watcher() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  if [[ -f "$ABORT_FILE" ]]; then
    cp "$ABORT_FILE" "$RUN_DIR/watcher-abort.json" 2> /dev/null || true
    die "the watcher aborted the run: $(cat "$ABORT_FILE")"
  fi
  kill -0 "$WATCH_PID" 2> /dev/null || die "the watcher is no longer running; stopping, as a run must not go unwatched"
}

wait_for_setting() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  local value="" waited=0
  while [[ "$value" != 400 ]]; do
    check_watcher
    [[ "$waited" -lt 600 ]] || die "max_connections is still not 400 after 10 minutes: the settings did not take effect"
    value="$(k exec "$PG-1" -c postgres -- psql -U postgres -d oci -Atc 'show max_connections' 2> /dev/null || true)"
    [[ "$value" == 400 ]] || { sleep 5; waited=$((waited + 5)); }
  done
  k wait --for=condition=Ready "pod/$PG-1" --timeout=300s
}

apply_pg_settings() {
  step "Apply the harness PostgreSQL settings and the resource requests and limits to the Cluster (the database restarts)"
  k patch cluster.postgresql.cnpg.io "$PG" --type merge -p "$(cli patch pg "$PG_SIZE")"
  step "Wait until the new settings are in effect"
  wait_for_setting
}

wait_no_app_pods() {
  [[ "$DRY_RUN" == 1 ]] && return 0
  local waited=0 pods
  while :; do
    pods="$(k get pods -l "app.kubernetes.io/instance=$NAME,app.kubernetes.io/component in (api,worker)" -o name)"
    [[ -z "$pods" ]] && return 0
    [[ "$waited" -lt 180 ]] || die "the API and worker pods did not stop: $pods"
    sleep 3
    waited=$((waited + 3))
  done
}

prepare_deployments() {
  step "Stop the API and worker (the generator drops and rebuilds indexes), then set the harness environment, resources and node pinning (load node $LOAD_NODE)"
  k scale "deployment/$API" "deployment/$WORKER" --replicas=0
  wait_no_app_pods
  local -a env_args=()
  local line deployment
  while IFS= read -r line; do env_args+=("$line"); done < <(cli flags api-env "$NAME")
  local -a res_args=()
  while IFS= read -r line; do res_args+=("$line"); done < <(cli flags resources api)
  for deployment in "$API" "$WORKER"; do
    k set env "deployment/$deployment" "${env_args[@]}"
    k set resources "deployment/$deployment" "${res_args[@]}"
    k patch "deployment/$deployment" --type=strategic -p "$(cli patch selector "$LOAD_NODE")"
  done
  local -a web_env=()
  while IFS= read -r line; do web_env+=("$line"); done < <(cli flags web-env)
  k set env "deployment/$WEB" "${web_env[@]}"
  k patch "deployment/$WEB" --type=strategic -p "$(cli patch selector "$LOAD_NODE")"
  step "Wait for the web proxy to roll out on $LOAD_NODE"
  k rollout status "deployment/$WEB" --timeout=300s
}

# Renders a template (checked: label, namespace, names) and applies it.
apply_template() {
  local template="$1"
  shift
  local rendered
  rendered="$(cli render "$template" --env "$NAME" "$@")" || die "could not render $template"
  step "Apply $template ($(printf '%s\n' "$rendered" | grep -c '^kind:') objects)"
  if [[ "$DRY_RUN" == 1 ]]; then
    scope_args apply --server-side --force-conflicts --field-manager=scale-cluster -f - || exit 2
    printf '  + kubectl'
    printf ' %q' "${K_ARGS[@]}"
    printf ' < %s\n' "$template"
    return 0
  fi
  printf '%s\n' "$rendered" | k apply --server-side --force-conflicts --field-manager=scale-cluster -f -
}

prepare_files() {
  step "Pack tools/scale (without results) for the ConfigMap, and write the per-run token to a private file"
  COPYFILE_DISABLE=1 tar -czf "$WORK/scale.tgz" -C "$HERE" --exclude=results --exclude=k8s --exclude=.DS_Store .
  base64 < "$WORK/scale.tgz" | tr -d '\n' > "$WORK/scale.b64"
  local size
  size="$(wc -c < "$WORK/scale.b64" | tr -d ' ')"
  [[ "$size" -lt 900000 ]] || die "tools/scale packs to $size bytes of base64, over the ConfigMap limit"
  (umask 077 && random_hex 24 > "$WORK/metrics-token")
  if [[ "$DRY_RUN" == 1 ]]; then
    printf 'e30=' > "$WORK/environment.b64"
    return 0
  fi
  k get nodes -o json > "$WORK/nodes.json"
  cli environment-json --nodes "$WORK/nodes.json" --db-node "$DB_NODE" --load-node "$LOAD_NODE" --pg-size "$PG_SIZE" \
    --api-replicas "$REPLICAS" --k6-image "$K6_IMAGE" --commit "$COMMIT" | base64 | tr -d '\n' > "$WORK/environment.b64"
}

apply_workload() {
  apply_template harness-secret.yaml "METRICS_TOKEN@$WORK/metrics-token"
  apply_template tools-configmap.yaml "TOOLS_TGZ_B64@$WORK/scale.b64"
  apply_template environment-configmap.yaml "ENVIRONMENT_JSON_B64@$WORK/environment.b64"
  local -a vars=(
    "API_IMAGE=$API_IMAGE" "K6_IMAGE=$K6_IMAGE" "LOAD_NODE=$LOAD_NODE" "PROFILE=$PROFILE" "SEED=$SEED"
    "DIMENSIONS=$DIMENSIONS" "NOW_DATE=$DATE" "DEADLINE_SECONDS=$DEADLINE_SECONDS" "APP_URL=$APP_URL"
    "WAIT_BACKFILL=$(bool "$WAIT_BACKFILL")" "BACKFILL_WAIT_SECONDS=14400" "SKIP_RETENTION=$(bool $((1 - RETENTION)))"
    "API_REPLICAS=$REPLICAS" "STUB_FIRST_TOKEN_MS=$STUB_FIRST_TOKEN_MS" "STUB_TOKENS_PER_SECOND=$STUB_TOKENS_PER_SECOND"
    "STUB_REPLY_TOKENS=$STUB_REPLY_TOKENS" "COMMIT=$COMMIT"
    "METRICS_TOKEN@$WORK/metrics-token" "TOOLS_TGZ_B64@$WORK/scale.b64" "ENVIRONMENT_JSON_B64@$WORK/environment.b64"
  )
  apply_template stub.yaml "${vars[@]}"
  step "Wait for the stub model"
  k rollout status "deployment/$NAME-scale-stub" --timeout=300s
  step "Start the run Job: generate the dataset (2 workers), wait for the app, warm up, run k6 (main), collect, run retention, collect, render"
  apply_template run-job.yaml "${vars[@]}"
}

# The API and worker come back once the dataset exists, with the retention windows the generator
# suggests (the oldest quarter), read from the data's ages.
after_generation() {
  step "Generation finished: set the retention windows, then scale the API ($REPLICAS) and worker (1) back up"
  local ages usage_days="" audit_days=""
  local sql="select coalesce(extract(epoch from (timestamptz '$DATE 00:00:00+00' - min(occurred_at))) / 86400, 0), coalesce((select extract(epoch from (timestamptz '$DATE 00:00:00+00' - min(created_at))) / 86400 from audit_log), 0) from usage_event"
  ages="$(kq '360|364' exec "$PG-1" -c postgres -- psql -U postgres -d oci -At -F '|' -c "$sql" 2> /dev/null || true)"
  IFS='|' read -r usage_days audit_days <<< "$ages"
  if [[ -z "$usage_days" ]]; then log "Could not read the age of the data; the retention windows fall back to the generator's defaults"; fi
  local -a windows=()
  local line deployment
  while IFS= read -r line; do windows+=("$line"); done < <(cli flags retention-env "${usage_days:-}" "${audit_days:-}")
  for deployment in "$API" "$WORKER"; do k set env "deployment/$deployment" "${windows[@]}"; done
  k scale "deployment/$API" --replicas="$REPLICAS"
  k scale "deployment/$WORKER" --replicas=1
  k rollout status "deployment/$API" --timeout=900s
  k rollout status "deployment/$WORKER" --timeout=900s
}

save_failure() {
  local container="$1"
  if [[ -n "$POD" ]]; then
    k logs "$POD" -c "$container" 2>&1 | redact > "$RUN_DIR/failed-$container.log" || true
    k describe pod "$POD" 2>&1 | redact > "$RUN_DIR/pod-describe.txt" || true
    log "Last lines of $container:"
    tail -n 25 "$RUN_DIR/failed-$container.log" || true
  fi
}

monitor_run() {
  step "Follow the run pod: phases in order; scale the API and worker up when generation has finished"
  if [[ "$DRY_RUN" == 1 ]]; then
    POD="$NAME-scale-run-dryrun"
    printf '[dry-run] (would poll the pod every %s s, up to %s s, and log each phase as it ends)\n' "$POLL" "$DEADLINE_SECONDS"
    after_generation
    return 0
  fi
  local started=$SECONDS generated=0 finished="" state phase name code token pending_since=$SECONDS
  local -a parts
  while [[ $((SECONDS - started)) -lt $((DEADLINE_SECONDS + 300)) ]]; do
    check_watcher
    state="$(k get pods -l "$ENV_LABEL,app.kubernetes.io/name=scale-run" \
      -o 'jsonpath={.items[0].metadata.name}{" "}{.items[0].status.phase}{" "}{range .items[0].status.initContainerStatuses[*]}{.name}{":"}{.state.terminated.exitCode}{" "}{end}{"hold:"}{.items[0].status.containerStatuses[0].state.running.startedAt}' 2> /dev/null || true)"
    parts=()
    read -r -a parts <<< "$state" || true
    if [[ ${#parts[@]} -ge 2 ]]; then
      POD="${parts[0]}"
      phase="${parts[1]}"
      if [[ "$phase" == Pending ]]; then
        [[ $((SECONDS - pending_since)) -lt 600 ]] || { save_failure extract; die "the run pod has been Pending for 10 minutes (see $RUN_DIR/pod-describe.txt)"; }
      else
        pending_since=$SECONDS
      fi
      for token in "${parts[@]:2}"; do
        name="${token%%:*}"
        code="${token#*:}"
        [[ -n "$code" ]] || continue
        if [[ "$name" == hold ]]; then
          log "The run finished; copying the results"
          return 0
        fi
        if [[ " $finished " != *" $name "* ]]; then
          finished="$finished $name"
          if [[ "$code" == 0 ]]; then log "Phase $name finished"; else save_failure "$name"; die "phase $name failed with status $code"; fi
          if [[ "$name" == generate && "$generated" == 0 ]]; then
            generated=1
            after_generation
          fi
        fi
      done
      [[ "$phase" != Failed ]] || { save_failure hold; die "the run pod failed (deadline or a container error; see $RUN_DIR/pod-describe.txt)"; }
    fi
    sleep "$POLL"
  done
  die "the run did not finish within its deadline"
}

collect_results() {
  step "Copy the results out of the pod, and the pod's logs (database URLs redacted)"
  k cp "$POD:/results" "$WORK/results" -c hold
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '[dry-run] (would copy %s/* into %s and the report to %s.md and .json)\n' "$WORK/results" "$RUN_DIR" "$RESULTS/$RUN_NAME"
  else
    [[ -f "$WORK/results/report.json" ]] || die "the pod's results have no report.json"
    mkdir -p "$RUN_DIR"
    cp -R "$WORK/results/." "$RUN_DIR/"
    cp "$RUN_DIR/report.md" "$RESULTS/$RUN_NAME.md"
    cp "$RUN_DIR/report.json" "$RESULTS/$RUN_NAME.json"
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    k logs "$POD" --all-containers=true
  else
    k logs "$POD" --all-containers=true 2>&1 | redact > "$RUN_DIR/pod.log" || true
  fi
  k delete jobs -l "$ENV_LABEL" --wait=false --ignore-not-found
  log "Report: $RESULTS/$RUN_NAME.md (raw files in $RUN_DIR)"
}

# What is left of the environment, and whether the pool is back where it was.
verify_clean() {
  step "Verify teardown: nothing labelled $ENV_LABEL remains; for medium and large the pool is back at its starting allocation"
  if [[ "$DRY_RUN" == 1 ]]; then
    k get all,pvc,secret,configmap,clusters.postgresql.cnpg.io,serviceaccounts -l "$ENV_LABEL" -o name
    node_tool cluster-preflight.mjs pool --db-node "$DB_NODE"
    return 0
  fi
  local remaining="$WORK/remaining.txt" waited=0 before="" after="" ok=1
  before="$(cli json-get "$RUN_DIR/preflight.json" poolBeforeBytes 2> /dev/null || true)"
  while :; do
    local -a check=(teardown-check --profile "$PROFILE")
    rm -f "$remaining"
    if k get all,pvc,secret,configmap,clusters.postgresql.cnpg.io,serviceaccounts -l "$ENV_LABEL" -o name > "$remaining" 2> /dev/null; then
      check+=(--remaining "$remaining")
    fi
    if [[ "$PROFILE" == medium || "$PROFILE" == large ]]; then
      after="$(node "$LIB/cluster-preflight.mjs" pool --db-node "$DB_NODE" 2> /dev/null || true)"
      if [[ -n "$before" && -n "$after" ]]; then check+=(--pool-before "$before" --pool-after "$after"); fi
    fi
    if cli "${check[@]}"; then ok=0; break; fi
    [[ "$waited" -lt "$VERIFY_WAIT" ]] || break
    sleep "$POLL"
    waited=$((waited + 10))
  done
  if [[ "$ok" == 0 ]]; then log "Teardown verified: nothing remains${after:+; pool allocation $after bytes (before: $before)}"; return 0; fi
  log "NOT CLEAN: see above. Remove it with: $DEVENV down oci $NAME (the reaper also removes it at its TTL)"
  return 1
}

teardown() {
  local status=$?
  trap '' INT TERM HUP
  set +e
  stop_watcher
  if [[ "$UP_STARTED" == 1 ]]; then
    if [[ "$status" -ne 0 && "$KEEP_ON_ABORT" == 1 ]]; then
      log "Keeping $NAME until its TTL (--keep-on-abort). Remove it with: $DEVENV down oci $NAME"
    else
      step "Teardown: delete the run Job first (it is what writes), then remove the environment"
      k delete jobs -l "$ENV_LABEL" --wait=false --ignore-not-found
      devenv down oci "$NAME"
      if [[ "$DRY_RUN" != 1 ]]; then mkdir -p "$RUN_DIR"; fi
      if [[ "$DRY_RUN" == 1 ]]; then
        verify_clean
      else
        verify_clean 2>&1 | tee "$RUN_DIR/teardown.txt"
        if [[ "${PIPESTATUS[0]}" -ne 0 ]]; then
          [[ "$status" -ne 0 ]] || status=1
        fi
      fi
    fi
  fi
  if [[ "$DRY_RUN" == 1 ]]; then
    printf '[dry-run] dry run: nothing was created. Nothing was sent to the cluster.\n'
  else
    log "Ended (exit status $status)"
  fi
  rm -rf "$WORK"
  exit "$status"
}

# --- Run -----------------------------------------------------------------------------------------
log "Profile $PROFILE: database ${PG_SIZE} on $DB_NODE, load on $LOAD_NODE, ${REPLICAS} API replica(s), environment $NAME, commit $COMMIT, started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [[ "$PROFILE" == medium || "$PROFILE" == large ]]; then
  log "This shares the cluster with production services: run it in the maintainer's quiet hours"
fi

preflight
if [[ "$PREFLIGHT_ONLY" == 1 ]]; then
  step "--preflight-only: stopping here; nothing was created"
  rm -rf "$WORK"
  exit 0
fi
need_pg_node

trap teardown EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

create_environment
read_environment
check_pin
start_watcher
apply_pg_settings
prepare_files
prepare_deployments
apply_workload
monitor_run
collect_results
if [[ "$DRY_RUN" != 1 ]]; then log "Done: $PROFILE on the cluster"; fi
