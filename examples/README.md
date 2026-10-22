# Examples

The examples play every role against the local bundle — user, operator, admin
and the price signer — using only `@solana/web3.js` 1.x and `node:crypto`.
They need the bundle running with its guard (plain `../start.sh`) and Node 20
or later. `common.ts` holds what they share: the keys, the addresses and the
byte layout of every instruction and account they touch.

    npm ci
    npm run profit-withdrawal          # RPC_URL=http://127.0.0.1:8899 by default
    npm run liquidation

## profit-withdrawal.ts

What it does:

1. Creates a wallet, its passthrough `UserAccount`, and profile 0's USDC
   account with 1,000 USDC minted into it.
2. As the operator, passthrough `SUNRISE_DEPOSIT` opens a request for a $1,000
   SOL long with $200 of collateral; Sunrise `ACCEPT` fills it at $150, with a
   frame signed by `keys/oracle.json` in front of it.
3. A Sunrise DECREASE `REQUEST`, then `ACCEPT` at $165 with a fresh frame.
4. As the user, `WITHDRAW_COLLATERAL` of the whole balance, profit included.
5. The same open and close with a stale frame, with a frame signed by a key the
   guard does not list, and with a bad signature.

Output from a run on the bundle (fees are mainnet's 1 bp a fill):

    cluster clock is 1309 ms behind wall time (frames are stamped at wall time)
    guard trusts oracle 7YFkcBMDVSc97BC9268N8i6JCmZSCWHoMmT37DBrZXwi; SOL is Lazer feed 6

    == verified open and close, then withdraw everything
    open : { priced: '1', held: 0n }
    close: { priced: '1', held: 0n }
    margin collateral $299.790001 (deposit basis $200.000000, held $0.000000)
    WITHDRAW_COLLATERAL $299.790001: ok — profile USDC $800.000000 -> $1099.790001, profit $99.790001

    == close with a stale frame (10 s old; the guard admits ≤ 2000 ms)
    close ACCEPT succeeded: { priced: '0', held: 99890001n }
    margin collateral $299.790001, of which $99.790001 held until 2026-10-22T01:06:23.000Z
    withdraw everything ($299.790001): REJECTED — instruction 1 failed: Sunrise ProfitHeld (89) — "Withdrawal of 299790001 reaches 99790001 of held profit until 1792631183"
    withdraw the unheld $200.000000: ok
    admin RELEASE_HELD, then withdraw the $99.790001: ok

    == close with a frame signed by a key the guard does not list
    close ACCEPT succeeded: { priced: '0', held: 99890001n }
    margin collateral $299.790001, of which $99.790001 held until 2026-10-22T01:06:26.000Z
    withdraw everything ($299.790001): REJECTED — instruction 1 failed: Sunrise ProfitHeld (89) — "Withdrawal of 299790001 reaches 99790001 of held profit until 1792631186"
    withdraw the unheld $200.000000: ok
    admin RELEASE_HELD, then withdraw the $99.790001: ok

    == close with a frame claiming the oracle key but a bad signature
    close transaction REJECTED — instruction 1 failed: ed25519 precompile InvalidSignature
    nothing in it ran; the DECREASE request is still live until accepted or expired

Reading it:

* An untrusted frame never stops the close. The close runs, the `ACCEPT` log
  says `priced=0`, and the profit is held for the guard's `hold_secs` (8 h).
  `held=` in the log is what the close credited; the account holds at most the
  profit above its deposit basis, which the opening fee lowered by $0.10.
* The withdrawal reads no frame. It is where held profit is refused, and the
  unheld part still leaves. `RELEASE_HELD` (admin) frees the rest at once.
* A bad signature fails the ed25519 precompile, which fails the whole
  transaction: the close itself never happens.

Each scenario uses a new wallet, so the script can be run any number of times
against one validator.

## liquidation.ts

Liquidations are signed by the Sunrise operator (the config's `operator` key)
and refused from any other signer. **Your program cannot send or CPI them; it
observes them.** The instructions below are printed in full so you can
recognise them in a transaction and know what changes in the accounts you
watch.

What it does:

0. Gives BTC mainnet's isolated-seat tier, 250x at 20 bps maintenance
   (`docs/armada/market-tiers.csv` in the Imperial repo). The bundle ships no
   tiers. A tier lives in the market's funding index
   `["sunfund", [hedge_venue], asset_key]`, so the operator first creates the
   index with `SET_FUNDING_RATE` (12) at rate 0, then the admin sends
   `SET_MARKET_RISK` (38). Mainnet BTC carries the same tier; read any
   market's from its funding index (`u64` at offset 64: tag `0x5254` in the
   top 16 bits, leverage in bits 16–31, maintenance bps in bits 0–15).
1. Isolated: a user with a $1,000 SOL long on their cross seat opens a $24,000
   BTC long with $100 on an isolated seat. It is liquidated one cent inside its
   maintenance line, after being refused one cent above it.
2. Cross: a user holds $1,000 SOL and $3,500 BTC longs on one cross seat with
   $200. BTC falls; the seat is refused one cent above its line and liquidated
   at it; the remainder is withdrawn.

Output from a run on the bundle:

    BTC funding index BtiMDxqFpDPDGDgbwVxvjrag8mK6F8Br3Vnao3R2UJUi: tier 250x at 20 bps maintenance (version 1), funding rate 0

    == 1. isolated seat: BTC long at 250x, beside a SOL cross long
    isolated seat 2qFmtcVxknUwhFtwwLpE3u2DjPqcwWJoKqQNWm1Ctpdt: deposited $100.000000, collateral after the open fee $97.600000, position $24000 at $100000.00 (245.901x)
    cross seat: collateral $199.900000, SOL $1000; profile USDC $700.000000
    maintenance line: liquidatable at BTC ≤ $99792.91

    BEGIN_LIQUIDATION at $99792.91: REJECTED — instruction 1 failed: Sunrise PrimeOperationUnsupported (86)
      (a position opened under a market tier settles only through SETTLE_NATIVE_LIQUIDATION)
    SETTLE_NATIVE_LIQUIDATION at $99792.92 (1¢ above): REJECTED — instruction 1 failed: Sunrise AccountNotLiquidatable (50)
    SETTLE_NATIVE_LIQUIDATION at $99792.91: ok 3Tt8B4W5SD4a8L1GBivw8m2eQw8Zi7xyNYW6wJzSZCj8rJcPnVA99ZhQchzcexq1pMLMg8AyrNxfxHTFEAvmsNov
      SETTLE_NATIVE_LIQUIDATION: program ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB
        data (81 bytes) 1b010000000000000036000000000000003600000000000000e863da6a00000000809ff3d8c25a0000000000000000000000000000000000000000000000000000001c4e0e000000000042d10500000000
         0 sw 8Uu3VEteWBP7msbrkW7F1yKdnm516mVE2DtFBSonG1nY operator
         1 -- EP1U2mnN5ubYd8P5st2SGPNaBfE8XbBrC5oHYGpCamp8 config
         2 -w HY6K2hWFtD95QJWLTcAk4nXCvKz4qhDty9v6UpBPkYQ8 vault
         3 -w 2qFmtcVxknUwhFtwwLpE3u2DjPqcwWJoKqQNWm1Ctpdt margin (isolated BTC seat)
         4 -w Feay6eUPTG5AAYWw97xDWDXuzJUQ9Qpcy9R3VvZTBwfw receipt [sunliq, margin, revision]
         5 -w BNZiPZ3YBm8tCBocgkJW6NRJsAif8oYJ993YnDYxqQ1V position (BTC, iso)
         6 -- 11111111111111111111111111111111             system program
         7 -- BtiMDxqFpDPDGDgbwVxvjrag8mK6F8Br3Vnao3R2UJUi funding index (BTC)
      logs:
        Program log: SunriseLiquidationFinalize seized=97600000 residual=0
        Program log: SunriseLiquidate profile=[195, 17, 133, 150, 204, 98, 28, 41, 121, 216, 166, 224, 46, 71, 84, 157, 227, 209, 21, 149, 174, 126, 53, 190, 109, 120, 140, 67, 36, 201, 103, 11] positions=1 seized=97600000 equity=47898400 seat=BTC mmr=47900597 fee=47898400 margin_collateral=0 gross_at_mark=23950298400
      receipt Feay6eUPTG5AAYWw97xDWDXuzJUQ9Qpcy9R3VvZTBwfw: settled=1 venue_first=1 collateral $97.600000, equity at mark $47.898400, maintenance $47.900597, gross at mark $23950.298400, fee $47.898400, residual $0.000000
    isolated seat: collateral $97.600000 -> $0.000000 (lost $97.600000), open positions 0, position account closed
    cross seat: collateral $199.900000 -> $199.900000, SOL $1000 -> $1000; profile USDC $700.000000 -> $700.000000

    == 2. cross seat: SOL and BTC longs on one balance
    cross seat 89ftRuHJqvxXPovaNc596VtVWDhPrWf5HBuQw1Yoh8pk: deposited $200.000000, collateral after the open fees $199.550000, gross $4500 (SOL $1000 at $150, BTC $3500 at $100000)
    maintenance line with SOL at $150 (simulated BEGINs): liquidatable at BTC ≤ $98098.67

    BEGIN_LIQUIDATION at BTC $98098.68 (1¢ above): REJECTED — instruction 1 failed: Sunrise AccountNotLiquidatable (50)
    BEGIN_LIQUIDATION at BTC $98098.67: ok 5JkZwwpEudxMMi3fWFBgCkGrwYNJFaD5ZPDPHR6VVGSUrHNvBuZLb2Dkawoec2BPtEAuFjrqNb98ZjDKFq6nDajD
      BEGIN_LIQUIDATION: program ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB
        data (73 bytes) 13020000000000000000000000000000000200000000000000005cb2ec220000000000000000000000000000000000000080d760603859000000000000000000000000000000000000
         0 sw 8Uu3VEteWBP7msbrkW7F1yKdnm516mVE2DtFBSonG1nY operator
         1 -- EP1U2mnN5ubYd8P5st2SGPNaBfE8XbBrC5oHYGpCamp8 config
         2 -w 89ftRuHJqvxXPovaNc596VtVWDhPrWf5HBuQw1Yoh8pk margin (cross seat)
         3 -w DvExq6bvWx8nNmubb23bmyartdEEugnAhcfWyUyaDBKj intent [sunliq, margin, revision]
         4 -- 11111111111111111111111111111111             system program
         5 -- LytVkfXXBozyDZKKvtP2SKokYq2hMkCRnanEBg14SaK  position SOL
         6 -- CACurkyTXwUu4KPRm9Fq4fE1yXN5EAYstP28czi3Dysv position BTC
         7 -- AdX7EZ8pQ8upYk9xwY6T2UHKv7EdffYeSDwHYKCr2YsB funding index SOL (absent here: accrues nothing)
         8 -- BtiMDxqFpDPDGDgbwVxvjrag8mK6F8Br3Vnao3R2UJUi funding index BTC
         9 -- 5pSicRR5RY6kakS6SiZn9uhxxwKLRqXFu8v611FpE8RT liquidation policy SOL (absent: policy_version 0)
        10 -- FLfamfsYWCH4DJt9jiW6kLXxkNawEfbnjvheN9wmRPYh liquidation policy BTC (absent: policy_version 0)
        11 -- GSJV9PkdgvVTCJxGwrM9oF5rwR9X7fQY3TKmjR8jR13P portfolio risk [sunportfolio]
      logs:
        Program log: SunriseLiquidationBegin revision=2 positions=2
      margin between the two: liquidation_reserved=true, revision 2 -> 3, collateral $199.550000, positions still open: 2
    FINALIZE_LIQUIDATION: ok 4aaeaqHcHPFWQxN1ZhDAR3RDhKtQBzPA2v4utZU46Yzd28hob2tye3uAMfBymfc6YXJb7xLeEkYbA3MB1LEdHFoA
      FINALIZE_LIQUIDATION: program ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB
        data (1 bytes) 14
         0 sw 8Uu3VEteWBP7msbrkW7F1yKdnm516mVE2DtFBSonG1nY operator
         1 -- EP1U2mnN5ubYd8P5st2SGPNaBfE8XbBrC5oHYGpCamp8 config
         2 -w HY6K2hWFtD95QJWLTcAk4nXCvKz4qhDty9v6UpBPkYQ8 vault
         3 -w 89ftRuHJqvxXPovaNc596VtVWDhPrWf5HBuQw1Yoh8pk margin (cross seat)
         4 -w DvExq6bvWx8nNmubb23bmyartdEEugnAhcfWyUyaDBKj intent
         5 -w LytVkfXXBozyDZKKvtP2SKokYq2hMkCRnanEBg14SaK  position SOL
         6 -w CACurkyTXwUu4KPRm9Fq4fE1yXN5EAYstP28czi3Dysv position BTC
         7 -- DjJbwMgGLeab2mvS2RUXXQq82MiqDVMVaKk3mK6RUVBX guard config
      logs:
        Program log: SunriseLiquidationFinalize seized=110881084 residual=88668916
        Program log: SunriseLiquidate profile=[185, 236, 35, 72, 177, 181, 0, 91, 224, 7, 147, 146, 169, 96, 195, 24, 97, 42, 15, 71, 194, 1, 158, 0, 169, 36, 92, 176, 105, 221, 74, 43] positions=2 seized=110881084 equity=133003450 seat=- mmr=133003604 fee=44334534 margin_collateral=88668916 gross_at_mark=4433453450
      receipt DvExq6bvWx8nNmubb23bmyartdEEugnAhcfWyUyaDBKj: settled=1 venue_first=0 collateral $199.550000, equity at mark $133.003450, maintenance $133.003604, gross at mark $4433.453450, fee $44.334534, residual $88.668916
    cross seat: collateral $199.550000 -> $88.668916 (lost $110.881084), open positions 0, SOL position closed, BTC position closed
    WITHDRAW_COLLATERAL $88.668916 (user-signed): profile USDC $800.000000 -> $888.668916

Reading it:

* **The line.** A seat is liquidatable when its equity at the marks is
  strictly below its maintenance requirement: `collateral + Σ PnL − funding <
  ceil(Σ notional_at_mark × maintenance_bps / 10000)`, with
  `notional_at_mark = size × mark / entry`. One cent above the line the
  program refuses with `AccountNotLiquidatable` (custom error 50, `0x32`).
  The mark is the operator's. A mark further than `max_liquidation_move_bps`
  (5000) from the entry still liquidates, but unless a signed price frame
  verifies it the seat settles at the band's edge.
* **Isolated seat, tiered market: the whole seat is lost.** A position opened
  under a tier pins native liquidation terms at ACCEPT, with a liquidation fee
  of 100%. It settles only through `SETTLE_NATIVE_LIQUIDATION` (27), which does
  BEGIN's checks and FINALIZE's settlement in one instruction;
  `BEGIN_LIQUIDATION` refuses it with `PrimeOperationUnsupported` (86). The fee
  takes the whole equity, so the residual is 0: of the $97.60 left after the
  open fee, $49.70 was the loss to the mark and $47.90 the fee. Nothing outside
  the seat moves: the cross seat, its SOL position and the profile's USDC are
  as they were.
* **Cross seat: every position on it closes, and the rest stays.**
  `BEGIN_LIQUIDATION` must list every open position on the seat
  (`IncompletePositionSet`, 55, otherwise) — the SOL long closed although only
  BTC moved. The fee is `liquidation_fee_bps` (100, i.e. 1%) of the gross
  notional at the marks, capped at the equity; `residual = equity − fee`
  stays in the cross margin account as collateral. Here $199.55 became
  $88.67: $66.55 of loss to the marks and a $44.33 fee. The user withdraws it
  with `WITHDRAW_COLLATERAL` like any balance; a liquidation itself moves no
  USDC.
* **Between BEGIN and FINALIZE** the margin account is `liquidation_reserved`
  (`MarginAccount._reserved[0]` bit 2): new requests, fills, collateral moves
  and withdrawals on it are refused (`LiquidationReserved`, 80) until FINALIZE.
* **The portfolio account.** A cross seat's maintenance nets across
  correlated markets through the portfolio risk account (`["sunportfolio"]`),
  and BEGIN on a seat with two or more positions must carry it after the
  liquidation policies, or it fails with `PortfolioRiskRequired` (104). The
  bundle has mainnet's portfolio account, but no market here belongs to a
  correlation group, so locally it nets nothing. That is why the example asks
  the program for the line (simulated BEGINs) rather than computing it.

The instructions (`programs/imperial_sunrise/src/wire.rs`,
`src/instructions/liquidation.rs`, `src/instructions/prime_venue_first.rs`):

| instruction | data | accounts |
|---|---|---|
| `BEGIN_LIQUIDATION` (19, `0x13`) | `u8 19`, `expected_revision u64`, `_reserved u64` (0), `position_count u8`, 7 bytes padding; then per position `mark u64` (1e-9), `policy_version u64`, `reserve_bps u16`, 6 bytes padding | operator (s, w), config, margin (w), intent `["sunliq", margin, expected_revision]` (w), system program, position × N, funding index × N, liquidation policy `["sunliqrisk", [hedge_venue], asset_key]` × N; the portfolio account `["sunportfolio"]` (required for two or more positions), then optionally `[guard_config, feed_table, instructions sysvar]` |
| `FINALIZE_LIQUIDATION` (20, `0x14`) | `u8 20` only | operator (s, w), config, vault (w), margin (w), intent (w), position (w) × N, optionally guard config |
| `SETTLE_NATIVE_LIQUIDATION` (27, `0x1b`) | `u8 27`, `expected_revision u64`, `opened_at_slot u64`, `observed_slot u64`, `observed_ts i64`, `mark u64`, `_reserved [u64; 2]`, `debt_at_trigger u64` (0), `closed_base u64` (the position's `hedged_base`), `expected_collateral u64` | operator (s, w), config, vault (w), margin (w), receipt `["sunliq", margin, expected_revision]` (w), position (w), system program, optionally `[guard_config, feed_table, instructions sysvar]`, funding index (last) |

`expected_revision` is the margin account's revision (`u64` at offset 120);
a stale one fails with `LiquidationIntentMismatch` (81). The guard tail only
decides whether a residual above the collateral is held; it never refuses a
liquidation.

How to detect a liquidation of a position you watch:

* **Logs**, from the Sunrise program's own invocation (between
  `Program ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB invoke` and its
  `success`):
  * `SunriseLiquidationBegin revision=<r> positions=<n>` — BEGIN only; nothing
    has settled yet.
  * `SunriseLiquidationFinalize seized=<µUSDC> residual=<µUSDC>` — FINALIZE and
    `SETTLE_NATIVE_LIQUIDATION`.
  * `SunriseLiquidate profile=[<32 bytes, decimal>] positions=<n> seized=<µUSDC>
    equity=<µUSDC> seat=<asset key, or - for cross> mmr=<µUSDC> fee=<µUSDC>
    margin_collateral=<µUSDC> gross_at_mark=<µUSD>` — the settlement, right
    after it. `seized` is the collateral the seat lost (PnL and fee together);
    `margin_collateral` is what it still holds. A second isolated seat on the
    same asset prints as `seat=BTC#2`.
* **Accounts**, which is what an on-chain program can see:
  * every position on the seat is closed (its lamports go to the operator);
  * the margin account's `collateral` (offset 72) is the residual,
    `gross_notional_usd` (80) and `open_positions` (88) are 0, and its
    revision (120) has advanced by 2;
  * a receipt exists at `["sunliq", margin, revision before the liquidation]`,
    owned by Sunrise, 152 + 80 × positions bytes
    (`src/state/liquidation.rs` `LiquidationIntent`): `settled` at byte 3,
    `venue_first` at 5, `collateral` 96, `residual` 104, `fee` 112,
    `gross_at_mark` 120, maintenance 128, equity (`i128`) 136. A close
    creates no receipt, so the receipt is what tells a liquidation from a
    close.

Each scenario uses a new wallet, and the tier setup is skipped when BTC already
has it, so the script can be run any number of times against one validator.
