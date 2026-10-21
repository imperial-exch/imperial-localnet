#!/usr/bin/env bash
# Starts solana-test-validator with Imperial's programs at their mainnet
# addresses and the pre-initialized accounts, keyed to this machine's own
# admin and operator (generated into ./keys on first run). Extra arguments
# are passed through to solana-test-validator (add your own programs here).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p keys
for role in admin operator; do
  [ -f "keys/$role.json" ] ||
    solana-keygen new --no-bip39-passphrase --silent -o "keys/$role.json" >/dev/null
done
python3 -I rekey.py
accounts=()
for f in .local/accounts/*.json; do
  accounts+=(--account "$(basename "$f" .json)" "$f")
done
exec solana-test-validator --reset \
  --bpf-program pASsDHVUtgG5uomQ29SVMv1sQxon4Gi6g5bJV7KKqZ8 programs/imperial_passthrough.so \
  --bpf-program ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB programs/imperial_sunrise.so \
  "${accounts[@]}" "$@"
