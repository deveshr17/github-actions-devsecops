#!/usr/bin/env bash
# Render a Kustomize overlay and validate the result.
#
# Usage: scripts/kustomize-validate.sh k8s/overlays/prod
#
# - Renders with `kustomize` if present, otherwise `kubectl kustomize`.
# - Runs kubeconform (strict, pinned Kubernetes version) when it is installed.
# - Enforces a few repository policies that schema validation cannot express.
set -euo pipefail

overlay="${1:?usage: $0 <overlay-dir>}"
k8s_version="${KUBERNETES_VERSION:-1.30.0}"

if command -v kustomize >/dev/null 2>&1; then
  render() { kustomize build "$1"; }
else
  render() { kubectl kustomize "$1"; }
fi

echo "==> rendering ${overlay}"
rendered="$(mktemp)"
trap 'rm -f "${rendered}"' EXIT
render "${overlay}" > "${rendered}"

echo "==> resources:"
grep -E '^kind:' "${rendered}" | sort | uniq -c | sed 's/^/    /'

if command -v kubeconform >/dev/null 2>&1; then
  echo "==> kubeconform (kubernetes ${k8s_version})"
  kubeconform -strict -summary -ignore-missing-schemas \
    -kubernetes-version "${k8s_version}" \
    -schema-location default \
    "${rendered}"
else
  echo "==> kubeconform not installed; skipping schema validation"
fi

echo "==> policy checks"
fail=0

# 1. Every image is tagged or digest-pinned, and never `latest`.
while read -r img; do
  ref="${img##*/}"
  case "${ref}" in
    *@sha256:*|*:*) ;;
    *) echo "    FAIL: image without tag or digest: ${img}"; fail=1 ;;
  esac
  case "${img}" in
    *:latest) echo "    FAIL: image tagged :latest: ${img}"; fail=1 ;;
  esac
done < <(grep -E '^\s+image:' "${rendered}" | awk '{print $2}')

# 2. Every Deployment container has resource limits and all three probes.
deployments=$(grep -c '^kind: Deployment$' "${rendered}" || true)
for key in 'limits:' 'startupProbe:' 'livenessProbe:' 'readinessProbe:' 'readOnlyRootFilesystem: true' 'runAsNonRoot: true' 'allowPrivilegeEscalation: false'; do
  count=$(grep -c "${key}" "${rendered}" || true)
  if [ "${count}" -lt "${deployments}" ]; then
    echo "    FAIL: ${key} missing for at least one Deployment"; fail=1
  fi
done

# 3. No inline Secret values.
if grep -E '^kind: Secret$' "${rendered}" >/dev/null; then
  echo "    FAIL: Secret objects must not be rendered from this repository"; fail=1
fi

if [ "${fail}" -ne 0 ]; then
  echo "policy checks failed for ${overlay}"
  exit 1
fi
echo "==> ${overlay} OK"
