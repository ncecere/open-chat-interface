#!/usr/bin/env bash
# Renders every template in tools/scale/k8s with example values and validates the result against
# the Kubernetes schemas with kubeconform (the tool .github/workflows/helm.yml installs). No
# cluster is contacted: kubeconform only reads schemas (from its cache or the schema repository).
#
#   tools/scale/k8s/validate.sh [kubernetes version, default 1.33.0]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$HERE/../lib/cluster-cli.mjs"
VERSION="${1:-1.33.0}"

command -v kubeconform > /dev/null || { echo "kubeconform is not installed (see .github/workflows/helm.yml)" >&2; exit 1; }
command -v node > /dev/null || { echo "node is not installed" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for template in "$HERE"/*.yaml; do
  name="$(basename "$template")"
  node "$CLI" render "$name" --example > "$WORK/$name"
done

kubeconform -strict -summary -kubernetes-version "$VERSION" "$WORK"/*.yaml
