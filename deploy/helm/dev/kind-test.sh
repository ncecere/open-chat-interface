#!/usr/bin/env bash
# Install and upgrade test of the Helm chart on a local cluster (kind), run by
# .github/workflows/helm.yml and by hand:
#
#   kind create cluster --name oci-helm
#   docker build -f docker/api.Dockerfile -t oci-helm-test/api:local .
#   docker build -f docker/web.Dockerfile -t oci-helm-test/web:local .
#   docker tag oci-helm-test/api:local oci-helm-test/api:local2   # likewise web
#   kind load docker-image --name oci-helm oci-helm-test/{api,web}:{local,local2}
#   deploy/helm/dev/kind-test.sh
#
# In a namespace that enforces Pod Security "restricted": installs with the
# dev dependencies (single-pod PostgreSQL and Redis), checks the hooks, the
# rollouts, readiness through the web Service, `helm test` and the API
# network policy; then upgrades to the :local2 tag under steady load (both
# hooks, a rolling update of every Deployment) and requires no failed request.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart="$here/../open-chat-interface"
ns=${OCI_TEST_NAMESPACE:-oci}
release=oci
name="$release-open-chat-interface"
k() { kubectl -n "$ns" "$@"; }

diagnostics() {
  echo "::group::Diagnostics"
  k get all,jobs,networkpolicy,pdb -o wide || true
  k get events --sort-by=.lastTimestamp | tail -60 || true
  for pod in $(k get pods -o name); do
    echo "--- $pod"
    k describe "$pod" | tail -25 || true
    k logs "$pod" --all-containers --tail=80 || true
  done
  echo "::endgroup::"
}
trap 'echo "FAILED at line $LINENO"; diagnostics' ERR

# A short-lived pod that passes the restricted profile, running a shell
# command with the web image (busybox wget).
run_pod() {
  local pod=$1 command=$2
  k delete pod "$pod" --ignore-not-found --now >/dev/null
  k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $pod
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: main
      image: oci-helm-test/web:local
      imagePullPolicy: Never
      command: ["sh", "-c", $(printf '%s' "$command" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: [ALL] }
      volumeMounts: [{ name: tmp, mountPath: /tmp }]
  volumes: [{ name: tmp, emptyDir: {} }]
EOF
}
wait_pod() {
  local pod=$1 timeout=${2:-120}
  for _ in $(seq 1 "$timeout"); do
    case $(k get pod "$pod" -o jsonpath='{.status.phase}') in
      Succeeded | Failed) k logs "$pod"; return 0 ;;
    esac
    sleep 1
  done
  echo "Pod $pod did not finish"
  return 1
}

check_hooks() {
  local tag=$1
  for job in "$name-migrate" "$name-migrate-post"; do
    test "$(k get job "$job" -o jsonpath='{.status.succeeded}')" = 1
    test "$(k get job "$job" -o jsonpath='{.spec.template.spec.containers[0].image}')" = "oci-helm-test/api:$tag"
  done
  k logs "job/$name-migrate" | grep >/dev/null 'Migration complete'
  k logs "job/$name-migrate-post" -c wait-for-rollout | tee /dev/stderr | grep >/dev/null 'runs this release'
  k logs "job/$name-migrate-post" -c migrate-post | grep >/dev/null 'Post-deploy steps complete'
  # The hooks' ServiceAccount and Role exist only while they run.
  test -z "$(k get serviceaccount,role,rolebinding -o name | grep migrate || true)"
  for component in api worker web; do
    k rollout status "deployment/$name-$component" --timeout=60s
    # Every pod not already terminating runs the new images.
    k get pods -l "app.kubernetes.io/component=$component" -o json | python3 -c '
import json, sys
tag = sys.argv[1]
pods = [p for p in json.load(sys.stdin)["items"] if not p["metadata"].get("deletionTimestamp")]
images = {c["image"] for p in pods for c in p["spec"]["containers"]}
assert pods and all(i.endswith(":" + tag) for i in images), images
' "$tag"
  done
}

echo "== Namespace (Pod Security: restricted) and dev dependencies"
kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace "$ns" pod-security.kubernetes.io/enforce=restricted --overwrite
k apply -f "$here/dependencies.yaml"
k wait --for=condition=available deployment/oci-dev-postgres deployment/oci-dev-redis --timeout=180s

echo "== helm install (no --wait: the post-install hook waits for the rollout itself)"
helm install "$release" "$chart" -n "$ns" -f "$here/values-kind.yaml" --timeout 10m
check_hooks local

echo "== Readiness through the web Service, and helm test"
run_pod ready-check "wget -qO- http://$name-web:8080/api/health/ready"
wait_pod ready-check | tee /dev/stderr | grep >/dev/null '"status":"ok"'
helm test "$release" -n "$ns" --timeout 2m

echo "== Caddy runs with every capability dropped (none added, an empty bounding set)"
test -z "$(k get deployment "$name-web" -o jsonpath='{.spec.template.spec.containers[0].securityContext.capabilities.add}')"
k exec "deployment/$name-web" -- grep CapBnd /proc/1/status | tee /dev/stderr | grep >/dev/null 'CapBnd:[[:space:]]*0000000000000000$'

echo "== Network policy: only the web pods reach the API"
run_pod np-check "wget -T 5 -qO- http://$name-api:3000/api/health/ready && echo REACHED || echo BLOCKED"
wait_pod np-check | tee /dev/stderr | grep >/dev/null BLOCKED
k exec "deployment/$name-web" -- wget -T 5 -qO- "http://$name-api:3000/api/health/ready" | grep >/dev/null '"status"'

echo "== helm upgrade to :local2 under load"
run_pod load "ok=0; fail=0; end=\$((\$(date +%s) + 90)); while [ \$(date +%s) -lt \$end ]; do
  for path in auth/status health/live; do
    if wget -T 10 -qO /dev/null http://$name-web:8080/api/\$path 2>/tmp/error; then ok=\$((ok+1));
    else fail=\$((fail+1)); echo \"\$(date +%T) FAIL \$path \$(cat /tmp/error)\"; fi
  done; sleep 0.05; done; echo \"RESULT ok=\$ok fail=\$fail\""
sleep 5
helm upgrade "$release" "$chart" -n "$ns" -f "$here/values-kind.yaml" --timeout 10m \
  --set image.api.tag=local2 --set image.web.tag=local2 \
  --set-string api.podAnnotations.oci-test/upgraded=true
check_hooks local2
result=$(wait_pod load 180 | tee /dev/stderr | grep RESULT)
[[ $result == *" fail=0" ]]
[[ $result != "RESULT ok=0 "* ]]
test "$(helm status "$release" -n "$ns" -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["status"])')" = deployed

k delete pod ready-check np-check load --ignore-not-found --now >/dev/null
echo "== Chart install and upgrade test passed ($result)"
