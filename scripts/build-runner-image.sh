#!/usr/bin/env bash
#
# Build the apps-father-runner Docker image.
#
# Usage:
#   ./scripts/build-runner-image.sh           # builds apps-father-runner:latest
#   TAG=v2 ./scripts/build-runner-image.sh    # builds apps-father-runner:v2
#
# Run from the repo root or from any directory — the script resolves paths
# relative to itself.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." &> /dev/null && pwd)"

TAG="${TAG:-latest}"
IMAGE="apps-father-runner:${TAG}"

echo ">>> Building ${IMAGE}"
echo "    Context: ${REPO_ROOT}/runner"

cd "${REPO_ROOT}"
docker build \
  --tag "${IMAGE}" \
  --file runner/Dockerfile \
  runner/

echo ""
echo ">>> Built image:"
docker image inspect "${IMAGE}" --format '    {{.RepoTags}} ({{.Size}} bytes, created {{.Created}})'
echo ""
echo "Next: ./scripts/setup-docker-network.sh   (one-time, idempotent)"
