#!/usr/bin/env bash
set -euo pipefail
# Run inside LXC 120, after publishing the two Pterodactyl allocations.
# Uses the observed Docker iptables backend; preserves all other rules.
iptables -nL DOCKER-USER >/dev/null
for port in 3001 25576; do
  rule=(-p tcp -s 10.0.0.117 -m conntrack --ctdir ORIGINAL --ctorigdst 10.0.0.58 --ctorigdstport "$port" -j ACCEPT)
  iptables -C DOCKER-USER "${rule[@]}" 2>/dev/null || iptables -I DOCKER-USER 1 "${rule[@]}"
  rule=(-p tcp ! -s 10.0.0.117 -m conntrack --ctdir ORIGINAL --ctorigdst 10.0.0.58 --ctorigdstport "$port" -j DROP)
  iptables -C DOCKER-USER "${rule[@]}" 2>/dev/null || iptables -I DOCKER-USER 1 "${rule[@]}"
done
iptables -nL DOCKER-USER --line-numbers
