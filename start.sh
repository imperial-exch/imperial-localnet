#!/usr/bin/env bash
# Starts solana-test-validator with Imperial's programs at their mainnet
# addresses and the pre-initialized accounts, keyed to this machine's own
# admin, operator and oracle (generated into ./keys on first run).
#
#   --no-guard   start without the price guard (see README, "Price guard")
#
# Every other argument is passed through to solana-test-validator (add your
# own --bpf-program / --account flags here).
set -euo pipefail
cd "$(dirname "$0")"
guard=1
args=()
for arg in "$@"; do
  if [ "$arg" = --no-guard ]; then guard=0; else args+=("$arg"); fi
done
mkdir -p keys
for role in admin operator oracle; do
  [ -f "keys/$role.json" ] ||
    solana-keygen new --no-bip39-passphrase --silent -o "keys/$role.json" >/dev/null
done
python3 -I rekey.py
dirs=(.local/accounts)
[ "$guard" = 1 ] && dirs+=(.local/accounts/guard)
accounts=()
for dir in "${dirs[@]}"; do
  for f in "$dir"/*.json; do
    accounts+=(--account "$(basename "$f" .json)" "$f")
  done
done
exec solana-test-validator --reset \
  --bpf-program pASsDHVUtgG5uomQ29SVMv1sQxon4Gi6g5bJV7KKqZ8 programs/imperial_passthrough.so \
  --bpf-program ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB programs/imperial_sunrise.so \
  "${accounts[@]}" ${args[@]+"${args[@]}"}
