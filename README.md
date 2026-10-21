# Imperial local validator bundle

The mainnet `imperial_passthrough` and `imperial_sunrise` binaries, deployed at
their mainnet addresses, with every admin account already initialized.
Fees and risk parameters are copied from mainnet; only the keys differ.

This repository contains no private keys. The first run of `start.sh`
generates your own admin and operator keys into `keys/` (gitignored) and
writes them into the account snapshots, so you control every role.

## Start

    ./start.sh                      # add your own --bpf-program / --account flags after it
    solana config set -u localhost
    solana airdrop 100 $(solana-keygen pubkey keys/admin.json)
    solana airdrop 100 $(solana-keygen pubkey keys/operator.json)

## Programs

| program | address |
|---|---|
| imperial_passthrough | `pASsDHVUtgG5uomQ29SVMv1sQxon4Gi6g5bJV7KKqZ8` |
| imperial_sunrise | `ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB` |

The programs check their own address, so they only work at these addresses.

| file | sha256 |
|---|---|
| `programs/imperial_passthrough.so` | `840841e489caf51a4ad20ffabbfa67490886abd57772283bff5b0003c43b2807` |
| `programs/imperial_sunrise.so` | `b329c26de6411f5857eab3c23abb132321131e4ad3f286d1f300360f65faa9b7` |

To check a binary against what is live now:
`solana program dump -u m <PROGRAM_ADDRESS> live.so && shasum -a 256 live.so`

## Keys

| file | role |
|---|---|
| `keys/admin.json` | passthrough `authority`; Sunrise `authority`; **USDC mint authority** |
| `keys/operator.json` | passthrough `operator`; Sunrise `operator` + `maker` — signs fills, closes and liquidations |

Both are created on your machine by `start.sh`. Delete `keys/` to get new ones.
Protocol fees go to a fixed fee-recipient address that nobody holds a key for.

## USDC

USDC lives at its real address (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals), so your programs need
no changes. Mint as much as you like:

    spl-token create-account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --owner <WALLET> --fee-payer keys/admin.json
    spl-token mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 1000000 <WALLET_USDC_ATA> --mint-authority keys/admin.json

## What is initialized

* passthrough `GlobalSettings` (`5cRBwzfnwuBGm4EviXmC6WJGtTRbs2jJHUCLH5bpXZ6r`)
* Sunrise config, and the vault seeded with **10000000 USDC** of house liquidity.
  Add more with Sunrise `FUND_VAULT`, signed by the admin.

Not set up: the Pyth Lazer price guard, per-market isolated leverage tiers,
portfolio margin, and funding rates. Without the guard, profit is paid out
without an oracle check, so the prices the operator reports are final.

## How an order executes

On mainnet Imperial's operator executes every fill; locally, you are the operator.

1. The user (or your program, by CPI) creates a passthrough Order with
   `underwriter = 7` (Sunrise). It is record-only: no fill happens yet.
2. The operator consumes it (passthrough `EXECUTE_ORDER_V2` consume), then
   sends passthrough `SUNRISE_DEPOSIT`, which moves the collateral into the
   Sunrise vault and opens a Sunrise request.
3. The operator sends Sunrise `ACCEPT` with the fill price and size. That
   price is what sets the position's entry.

Closes are a Sunrise `REQUEST` with action DECREASE, then `ACCEPT`.
Liquidations are Sunrise `BEGIN_LIQUIDATION` + `FINALIZE_LIQUIDATION`, signed
by the operator with the mark price you choose. That is how you move prices
locally: you report the fill prices and liquidation marks yourself.
