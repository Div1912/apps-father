#!/usr/bin/env bash
#
# One-time setup of the Docker network used by per-project workers.
#
# Creates a bridge network "apps-father-runners" with:
#   - icc=false       → containers on this network cannot talk to each other
#                       (no cross-project lateral movement)
#   - bridge          → outbound internet works (Telegram API, OpenAI, etc.)
#   - subnet 172.30.0.0/16 to keep it out of the default docker0 range
#
# Then installs an iptables rule that blocks containers on this network from
# reaching the host's local services (the platform main process on port 3000,
# postgres on 5432, etc.). Outbound internet stays open.
#
# Idempotent — safe to re-run.

set -euo pipefail

NET_NAME="apps-father-runners"
SUBNET="172.30.0.0/16"

echo ">>> Setting up Docker network: ${NET_NAME}"

if docker network inspect "${NET_NAME}" >/dev/null 2>&1; then
  echo "    network already exists, skipping create"
else
  docker network create \
    --driver bridge \
    --subnet "${SUBNET}" \
    --opt com.docker.network.bridge.enable_icc=false \
    --opt com.docker.network.bridge.name=br-afp-runners \
    "${NET_NAME}"
  echo "    network created"
fi

# Block containers from reaching the host's loopback / private services.
# The bridge gateway is the host as seen from containers (172.30.0.1 by default).
# Without this, a compromised worker could SSRF the platform's local API.
HOST_GW="172.30.0.1"

ensure_iptables_rule() {
  local rule="$1"
  if iptables -C ${rule} 2>/dev/null; then
    echo "    iptables rule already present: ${rule}"
  else
    iptables -I ${rule}
    echo "    iptables rule added: ${rule}"
  fi
}

if command -v iptables >/dev/null 2>&1; then
  echo ">>> Installing iptables egress filter (block container -> host gateway)"
  ensure_iptables_rule "DOCKER-USER -i br-afp-runners -d ${HOST_GW} -j DROP"
  ensure_iptables_rule "DOCKER-USER -i br-afp-runners -d 127.0.0.0/8 -j DROP"
  ensure_iptables_rule "DOCKER-USER -i br-afp-runners -d 169.254.0.0/16 -j DROP"  # cloud metadata
  ensure_iptables_rule "DOCKER-USER -i br-afp-runners -d 10.0.0.0/8 -j DROP"      # private LAN
  ensure_iptables_rule "DOCKER-USER -i br-afp-runners -d 192.168.0.0/16 -j DROP"  # private LAN
  echo "    Outbound internet remains OPEN (containers can reach Telegram API, etc.)"
else
  echo "    iptables not found — skipping host firewall rules. Containers will reach the host gateway!"
fi

echo ""
echo ">>> Done. Verify with:"
echo "    docker network inspect ${NET_NAME}"
echo "    iptables -S DOCKER-USER | grep br-afp-runners"
