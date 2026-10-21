# Imperial local validator bundle

The mainnet `imperial_passthrough` and `imperial_sunrise` binaries, deployed at
their mainnet addresses, with every admin account already initialized.
Fees, risk parameters and the price guard are copied from mainnet; only the
keys differ.

This repository contains no private keys. The first run of `start.sh`
generates your own admin, operator and oracle keys into `keys/` (gitignored)
and writes them into the account snapshots, so you control every role.

## Start

    ./start.sh                      # add your own --bpf-program / --account flags after it
    ./start.sh --no-guard           # the same, without the price guard (see "Price guard")
    solana config set -u localhost
    solana airdrop 100 $(solana-keygen pubkey keys/admin.json)
    solana airdrop 100 $(solana-keygen pubkey keys/operator.json)

Then run the worked example of a profitable close and withdrawal, with signed
prices (Node 20+):

    cd examples && npm ci && npm run profit-withdrawal

## Programs

| program | address |
|---|---|
| imperial_passthrough | `pASsDHVUtgG5uomQ29SVMv1sQxon4Gi6g5bJV7KKqZ8` |
| imperial_sunrise | `ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB` |

The programs check their own address, so they only work at these addresses.

| file | sha256 |
|---|---|
| `programs/imperial_passthrough.so` | `462b3dca88d9003b9c52014d55c4968e8b9f4f7abd8a5502498b0571f2c8a39f` |
| `programs/imperial_sunrise.so` | `b329c26de6411f5857eab3c23abb132321131e4ad3f286d1f300360f65faa9b7` |

To check a binary against what is live now:
`solana program dump -u m <PROGRAM_ADDRESS> live.so && shasum -a 256 live.so`

## Keys

| file | role |
|---|---|
| `keys/admin.json` | passthrough `authority`; Sunrise `authority` (guard config, feed table, `RELEASE_HELD`); **USDC mint authority** |
| `keys/operator.json` | passthrough `operator`; Sunrise `operator` + `maker` — signs requests, fills, closes and liquidations |
| `keys/oracle.json` | the price signer the guard trusts, in place of Pyth Lazer — signs price frames |

All three are created on your machine by `start.sh`. Delete `keys/` to get new ones.
Protocol fees go to a fixed fee-recipient address that nobody holds a key for.

`bundle.json` carries everything else a client needs: program and mint
addresses, the fee recipient, the live fill bounds, the guard parameters and
every market's Lazer feed id.

## USDC

USDC lives at its real address (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 decimals), so your programs need
no changes. Mint as much as you like:

    spl-token create-account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v --owner <WALLET> --fee-payer keys/admin.json
    spl-token mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 1000000 <WALLET_USDC_ATA> --mint-authority keys/admin.json

## What is initialized

* passthrough `GlobalSettings` (`5cRBwzfnwuBGm4EviXmC6WJGtTRbs2jJHUCLH5bpXZ6r`) and the fee recipient's USDC account
* Sunrise config, and the vault seeded with **10000000 USDC** of house liquidity.
  Add more with Sunrise `FUND_VAULT`, signed by the admin.
* the Sunrise price guard (`DjJbwMgGLeab2mvS2RUXXQq82MiqDVMVaKk3mK6RUVBX`) with mainnet's settings, and the
  feed table (`GbSDZjJSsKkjrBnRQNMAeMrSP2wvEhH31L53aobXLt3p`) with mainnet's 173 market → Lazer feed mappings.
  `start.sh --no-guard` leaves both out.

Not set up: per-market isolated leverage tiers, portfolio margin, and funding
rates (a market with no funding index accrues nothing).

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
by the operator with the mark price you choose. A close settles realized PnL
into the profile's Sunrise margin account; Sunrise `WITHDRAW_COLLATERAL` moves
it back to the profile's USDC account. `examples/profit-withdrawal.ts` does
steps 2–3, the close and the withdrawal by hand.

## Price guard: what happens to profit

**Price never refuses a fill.** Opens, closes and liquidations run whatever
price the operator reports, with or without a signed frame. A signed price
frame decides one thing: whether the profit a fill credits is **free at once
or held**. The withdrawal is where held profit is refused.

* A close's profit is free at once only when its `ACCEPT` carried a frame that
  verified **and** every opening fill of that position did too. Anything else —
  no frame, a stale one, one signed by a key the guard does not list, a price
  outside the band, a market missing from the feed table — credits the profit
  as **held** for `hold_secs` (8 hours). The `ACCEPT` log line
  shows it: `priced=1` verified, `0` no usable frame, `2` frame outside the band,
  and `held=<µUSDC>`.
* `WITHDRAW_COLLATERAL` reads **no** frame. It refuses an amount that reaches
  held profit with `ProfitHeld` (custom error 89, `0x59`); the unheld part can
  still be withdrawn. Withdrawing profit (anything above the deposit basis)
  also needs the guard config appended as an 8th account and must fit under the
  rolling caps ($25000/1h, $50000/24h; `ProfitCapExceeded`, 90).
  Principal always leaves.
* Held profit frees itself after `hold_secs`, or at once when the admin sends
  `RELEASE_HELD` (Sunrise instruction 34, accounts `[admin (signer), config,
  margin account (writable)…]`). Released profit joins the deposit basis, so
  it then withdraws like principal.
* A frame whose **signature does not verify** never reaches the program: the
  ed25519 precompile fails the whole transaction, so the close does not happen
  at all (the request stays live until it is accepted or expires).

**With `--no-guard`** there is no guard config: every fill is unverified, a
close's profit is held for 7 days, and even after that it cannot be withdrawn
(`GuardAccountsRequired`, 94) because there is no guard config to charge the
caps to. Only principal leaves, unless the admin sends `RELEASE_HELD`. This is
not how mainnet runs, which is why the guard is on by default.

| close's frame | close | profit | full withdrawal |
|---|---|---|---|
| verified (and the open was verified) | runs | free | succeeds (inside the caps) |
| none / stale / unlisted signer / off-band / unmapped market | runs | held 8 h | `ProfitHeld` until it frees or `RELEASE_HELD` |
| bad signature | transaction fails | — | — |
| any, with `--no-guard` | runs | held 7 days | `ProfitHeld`, then `GuardAccountsRequired`; `RELEASE_HELD` frees it |

## Signed price updates (Lazer frames)

Mainnet prices fills with Pyth Lazer frames in the `solana` format. Locally
`keys/oracle.json` is a trusted signer in their place, and the guard also keeps
mainnet's Pyth Lazer key (`9gKEEcFzSd1PDYBKWAKZi4Sq4ZCUaVX5oTr8kEjdwsfR`), so a frame from a real Lazer
stream verifies too.

**Where it goes.** An ed25519 precompile instruction placed **immediately
before** the `ACCEPT` it prices (the program reads the previous instruction
through the instructions sysvar), and `ACCEPT` gets three more accounts
appended after its 11: `[guard_config, feed_table, instructions sysvar]`.

    [compute budget…, ed25519 (frame), Sunrise ACCEPT (14 accounts)]

**The ed25519 instruction** carries the frame in its own data, and every
instruction-index field must be `0xFFFF` ("this instruction"); entries that
point elsewhere are ignored. With one frame:

| bytes | field |
|---|---|
| 0 | number of signatures (`1`; up to 255 frames, the first that verifies is used) |
| 1 | padding (`0`) |
| 2–3 | signature offset (`48`) |
| 4–5 | signature instruction index (`0xFFFF`) |
| 6–7 | public key offset (`16`) |
| 8–9 | public key instruction index (`0xFFFF`) |
| 10–11 | message offset (`112`) |
| 12–13 | message size (payload length) |
| 14–15 | message instruction index (`0xFFFF`) |
| 16–47 | signer public key |
| 48–111 | ed25519 signature over the payload |
| 112… | payload |

With several frames the 14-byte offset entries follow each other from byte 2,
then each frame's key, signature and payload.

**The payload** is pyth-lazer-protocol's `PayloadData`, little-endian:

| field | type |
|---|---|
| magic | `u32` = `2479346549` |
| timestamp_us | `u64`, microseconds since the Unix epoch |
| channel_id | `u8` |
| feed_count | `u8`, then per feed: |
| feed_id | `u32` |
| property_count | `u8`, then per property an id `u8` and its value: |
| 0 Price, 1 BestBid, 2 BestAsk, 5 Confidence, 10 EmaPrice, 11 EmaConfidence | `i64` (0 = absent) |
| 3 PublisherCount, 9 MarketSession | `u16` / `i16` |
| 4 Exponent | `i16` |
| 6 FundingRate, 7 FundingTimestamp, 8 FundingRateInterval, 12 FeedUpdateTimestamp | `u8` flag (1 = present) + `u64` |

An unknown property id or trailing bytes make the payload unusable. The price
is `Price × 10^Exponent`. Price, Exponent and FeedUpdateTimestamp are
required; BestBid/BestAsk are optional and widen the band.

**When it verifies.** All of these, else the price is unverified (profit held):

* the signer is one of the guard config's two `lazer_signers` — the key at the
  public-key offset, which the precompile has proven signed the payload;
* the payload has the feed the feed table maps the position's market to
  (SOL 6, BTC 1, ETH 2; all in `bundle.json`);
* **fresh**, against the cluster clock (`Clock::unix_timestamp` × 1000, which
  is whole seconds and on mainnet runs 1.4–1.9 s behind wall time):
  `−3500 ms ≤ now − timestamp ≤ max_frame_age_ms` (2000 ms), and the
  same for FeedUpdateTimestamp, which may not be later than the timestamp;
* not older than the margin account's last opening fill (whole seconds);
* the fill price is within `tolerance_base_bps + tolerance_spread_mult_x100 ×
  spread_bps / 100` of the frame's price (30 bps + 200% of the
  bid/ask spread, never more than 1000 bps).

Stamp frames with wall time, as Lazer does, and send them at once.

## Example

`examples/profit-withdrawal.ts` (TypeScript, `@solana/web3.js` 1.x, no
Imperial packages) creates a user, opens a $1,000 SOL long at $150 and closes
it at $165 with signed frames, withdraws the profit, and then shows a stale
frame, an unlisted signer and a bad signature. Every byte layout in it names
the program struct it mirrors. See `examples/README.md` for its output.
