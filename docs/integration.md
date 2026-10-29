# Integrating with Armada by CPI

Reference for a program that trades Armada (`imperial_sunrise`) by creating
passthrough Orders, by CPI, from its own PDA wallets. It covers market and seat
selection, TP/SL orders, cancellation finality and the websocket feeds.

All integers are little-endian. Units: `size_usd` and `collateral_amount` are
µUSDC (1e-6 USD); prices (`trigger_price`) have 9 decimals, so $97,500 is
`97_500_000_000_000`.

## 1. Markets and seats

### `market_mint` names the market and the seat

For `underwriter = 7` the 32-byte `market_mint` in `CREATE_ORDER` is not an
address; never pass it as an account. It encodes the market and the margin
seat:

| bytes | value |
|---|---|
| 0–14 | ASCII `imperial-sunr-x` (`69 6d 70 65 72 69 61 6c 2d 73 75 6e 72 2d 78`) |
| 15 | seat: `'0'` (`0x30`) cross, `'1'` (`0x31`) isolated, `'2'` (`0x32`) second isolated |
| 16–31 | asset symbol, uppercase ASCII, `NUL`-padded to 16 bytes |

The second isolated seat lets one profile hold an isolated long and an isolated
short in the same market at once.

Symbols are 1–16 characters of `A-Z 0-9 - .`, uppercase only. A lowercase or
otherwise malformed symbol does not decode, and the order is never filled.

| market | bytes 16–31 |
|---|---|
| BTC | `42 54 43` + 13 × `00` |
| NEAR | `4e 45 41 52` + 12 × `00` |
| ZEC | `5a 45 43` + 13 × `00` |
| WTI (oil) | `57 54 49` + 13 × `00` |
| BRENTOIL | `42 52 45 4e 54 4f 49 4c` + 8 × `00` |

Isolated BTC, in full:

    69 6d 70 65 72 69 61 6c 2d 73 75 6e 72 2d 78 31  42 54 43 00 00 00 00 00 00 00 00 00 00 00 00 00

The same order on the cross seat changes byte 15 to `30`.

An order with plain `imperial-sunrise` in bytes 0–15 names no seat. It then
follows the profile's open position in that market, and with none open it goes
to the profile's default seat. **Always name the seat.**

### Keep `phoenix_subaccount_index` consistent with the seat

The program never reads the seat out of `market_mint`. It uses
`phoenix_subaccount_index` for one rule: an increase with zero
`collateral_amount` is accepted only as a cross order (`phoenix_subaccount_index = 0`)
that draws on margin the cross seat already holds. Set them together:

| seat | byte 15 | `phoenix_subaccount_index` | `collateral_amount` |
|---|---|---|---|
| cross, new deposit | `'0'` | `0` | > 0 |
| cross, existing margin only | `'0'` | `0` | `0` |
| isolated | `'1'` or `'2'` | non-zero (e.g. `1`) | > 0 (the position's whole margin) |

The program does not check the two against each other. An isolated
`market_mint` with index 0 and no collateral is accepted at create, then
refused at fill for exceeding max leverage.

### Leverage

Leverage is `size_usd / collateral_amount`. An isolated seat's whole
`collateral_amount` is deposited at fill. A cross order deposits only what the
seat's free margin does not already cover.

* **Isolated seats** use the market's tier: a max leverage and a maintenance
  margin, stored on the market's funding-index account
  (`["sunfund", [1], symbol16]` under the Armada program). The current
  isolated tiers are BTC 250x (20 bps maintenance), NEAR 50x (60 bps),
  ZEC 50x (100 bps) and WTI 50x (111 bps). Tiers change. Read the account
  rather than hardcoding them.
* **Cross seats**, and markets with no tier, use the account-wide cap
  `max_leverage` in the Armada config (`bundle.json` → `max_leverage`).

**Local bundle:** isolated tiers are not seeded yet, so locally every market
uses the config cap. Above it, the fill (`ACCEPT`) fails with
`ExceedsMaxLeverage` (Armada error 52).

### What refuses an order

Checked when the order is created:

| error | cause |
|---|---|
| `InvalidUnderwriter` | retired underwriter |
| `InvalidOrderSize` | `size_usd == 0` |
| `InsufficientCollateral` | an increase with no collateral that is not a cross order |
| `InvalidSlippage` | an Armada increase with `slippage_bps == 0`, or any `slippage_bps` or `close_bps` over 10,000 |
| `ArmadaEscrowRequiresUsdc` | a resting limit open whose collateral mint is not USDC |

Market and leverage are checked only at fill. A refused fill retires the
order without a position. Watch for `order_rejected` on the websocket (§4).

## 2. TP/SL orders

A TP or SL is a passthrough `CREATE_ORDER` with `action = Decrease`. It rests
until Imperial's keeper sees the Armada mark price cross `trigger_price`, then
the keeper fills it as a close.

### `CREATE_ORDER` (discriminator 3): 73 bytes

| offset | field | type | TP/SL value |
|---|---|---|---|
| 0 | discriminator | u8 | `3` |
| 1 | market_mint | [u8; 32] | §1 (seat of the position being closed) |
| 33 | side | u8 | the **position's** side: `0` long, `1` short |
| 34 | order_type | u8 | `2` (StopLimit) |
| 35 | action | u8 | `1` (Decrease) |
| 36 | trigger_condition | u8 | `0` Above, `1` Below (table below) |
| 37 | order_bump | u8 | bump of the order PDA |
| 38 | profile_index | u8 | the profile holding the position |
| 39 | priority | u8 | `0` |
| 40 | funding_status | u8 | `0` (anything else is rejected) |
| 41 | size_usd | u64 | non-zero; see `close_bps` |
| 49 | collateral_amount | u64 | `0` |
| 57 | slippage_bps | u16 | e.g. `100` |
| 59 | underwriter | u8 | `7` |
| 60 | phoenix_subaccount_index | u8 | `0` cross, `1` isolated (match byte 15) |
| 61 | close_bps | u16 | share of the position to close, `1..=10000` |
| 63 | create_flags | u8 | `0` |
| 64 | padding | u8 | `0` |
| 65 | trigger_price | u64 | 9 decimals, non-zero |

Nothing follows the 73 bytes. Any trailing byte is rejected.

| position | take-profit | stop-loss |
|---|---|---|
| long (`side = 0`) | `Above` (0) | `Below` (1) |
| short (`side = 1`) | `Below` (1) | `Above` (0) |

### Accounts

| # | account | w | s |
|---|---|---|---|
| 0 | global settings `["global_settings"]` | | |
| 1 | user account `["user", wallet]` | w | |
| 2 | order `["order", profile, order_counter u64]` | w | |
| 3 | order's USDC ATA (not touched by a decrease; pass its address) | w | |
| 4 | wallet (your PDA, signing via `invoke_signed`; also pays rent) | w | s |
| 5 | profile `["profile", wallet, [profile_index]]` | w | |
| 6 | profile's USDC ATA | w | |
| 7 | USDC mint | | |
| 8 | system program | | |
| 9 | SPL Token program | | |

All PDAs are under the passthrough program. `order_counter` is the `u64` at
byte 40 of the user account. Read it immediately before the CPI, because each
create increments it. `create_order` also moves a little SOL rent from the
wallet into the profile, so the PDA wallet needs lamports.

### `close_bps`

* `close_bps` is applied to the position's size **when the order fires**, not
  when it was created. A TP at `5000` and an SL at `10000` on a $10,000
  position: if the TP fires first it closes $5,000, and the SL then closes
  100% of the remaining $5,000.
* `close_bps = 10000` is a full close.
* `close_bps = 0` is a legacy fixed-dollar close of `size_usd`, capped at the
  position size. Prefer `close_bps`.
* `size_usd` must still be non-zero. When `close_bps` is set it is ignored for
  sizing, so the position's current notional is a sensible value.

### Lifetime binding: create TP/SL after the position is open

Each TP/SL is bound to the **position lifetime** that was open in its market,
side and seat when the TP/SL was created:

* **Create it after the opening fill has landed.** A TP/SL created before its
  position exists is not bound to anything and never arms.
* When that position closes, the order is dead. If the same seat is reopened
  later, the new position never inherits an older TP/SL.

### Sibling cleanup after a competing exit

You do not need to cancel the other exit leg yourself:

* **Full close** (TP or SL at 10000, your own market close, or a liquidation):
  the keeper cancels every TP/SL still bound to that position. It cancels only
  after the position reads closed at **finalized** commitment, so expect the
  sibling cancel a short while after the close (seconds to a few minutes).
  Until then the sibling cannot fire, because it is checked against its own
  lifetime first.
* **Partial close**: siblings stay live and keep protecting the rest of the
  position.

You can still cancel a sibling yourself immediately with `OPERATOR_CANCEL_ORDER` (§3).

### Editing: `UPDATE_ORDER` (discriminator 10): 33 bytes

| offset | field | type |
|---|---|---|
| 0 | discriminator `10` | u8 |
| 1 | flags: bit 0 trigger_price, bit 1 size_usd, bit 2 slippage_bps, bit 5 close_bps | u8 |
| 2 | pro_order_type (`0`) | u8 |
| 3 | profile_index | u8 |
| 4 | priority | u8 |
| 5 | padding | [u8; 4] |
| 9 | trigger_price | u64 |
| 17 | size_usd | u64 |
| 25 | slippage_bps | u16 |
| 27 | close_bps | u16 |
| 29 | padding | [u8; 4] |

Accounts: `[global settings, order (w), user account, wallet (s), profile]`.
The edited order must pass the same checks as a create. An edit does not
change which position lifetime the order is bound to.

### Detecting a triggered exit, and one that fails

When a TP/SL fires, the keeper **consumes** the order before the fill: the
passthrough log says `Sunrise order consumed`, and the order PDA closes. The
fill is an Armada request whose id is derived from the order:

    request_id = u64_le(sha256(order_pda)[0..8])
    request PDA = ["sunreq", wallet, request_id u64] under the Armada program

The outcome is the Armada program log carrying that `id=`:

| log | meaning |
|---|---|
| `SunriseAccept id=…` | filled; the position shrank |
| `SunriseReject id=… refunded=…` | refused; the position is unchanged |
| `SunriseExpire id=… refunded=…` | not filled before `expiry_slot`; the position is unchanged |

* A request that is still open has `settled_at_slot == 0` at byte 200 of the
  216-byte request account. Its `expiry_slot` is the u64 at byte 168.
* Imperial's keeper sets requests to expire about 150 slots (~60 s) out.
* **A triggered exit has failed** when its order PDA has closed, but no
  `SunriseAccept` for its request id landed before that `expiry_slot`, and the
  position is still open.
* A consumed order does not come back. To keep the position protected,
  create a new TP/SL.
* On the websocket, a failed close shows up as `orders_updated` with no
  matching position change (§4).

## 3. Cancellation finality

### Cancelling: `OPERATOR_CANCEL_ORDER` (discriminator 8), wallet-signed

Data, 9 bytes: `[8, profile_index, 0, 0, 0, 0, 0, 0, 0]`.

| # | account | w | s |
|---|---|---|---|
| 0 | global settings | | |
| 1 | operator (`GlobalSettings.operator`; receives the rent, does **not** sign) | w | |
| 2 | order | w | |
| 3 | order's ATA for its collateral mint | w | |
| 4 | user account | | |
| 5 | wallet (your PDA) | w | s |
| 6 | profile | w | |
| 7 | profile's USDC ATA | w | |
| 8 | SPL Token program | | |

* **What it does:** returns any escrowed collateral (the escrow ATA's actual
  balance) to the profile's ATA, then closes the order. The rent of both
  accounts goes to the operator.
* **When it works:** on any Armada order the wallet owns, in any state, even
  while the program is paused.
* **When it fails:** once the order has been consumed. The account is gone, so
  the cancel fails, and that failure is itself the sign the keeper got there
  first.

### Why a closed order is not proof by itself

Both a cancel and a fill close the order account, and a fill's settlement can
land **after** the order account is gone:

* **Market, TP and SL orders** are consumed first, then filled through an
  Armada request that settles (accept, reject or expire) within its
  `expiry_slot`.
* **Resting limit orders** fill at the venue first and are recorded on chain
  afterwards, one leg at a time. If you cancel a resting limit by wallet,
  a leg that had already filled at the venue is still recorded after the
  cancel. It is paid from the profile's cash, not from the refunded escrow.

### The rule

Let `S` be the slot of the transaction that closed the order (your cancel, or
the keeper's consume). The order is final when all three hold:

1. **The order account is closed.**
2. **No unsettled request for it remains.** That means no request account
   for any of its ids with `settled_at_slot == 0`, unless `current_slot >
   expiry_slot`.
   * The ids are `u64_le(sha256(order_pda)[0..8])` and, for resting limits,
     one per leg: `u64_le(sha256(order_pda ‖ [leg])[0..8])` for `leg` in
     `0..=255`.
   * Alternatively, use one `getProgramAccounts` with `dataSize = 216` and a
     `memcmp` of your wallet at offset 8.
   * Settled requests stay as tombstones until they are reaped. Read
     `settled_at_slot`, not mere existence.
3. **The margin account has been quiet.**
   * The margin account is `["sunmargin", profile]` for cross, 128 bytes; it
     has a u64 `revision` at byte 120 that increases on every fill.
   * Its `revision` must not change between `S` and `S + W`.
   * Use `W` ≥ 90 s plus the request expiry window (≈ 150 slots) for
     resting limits. For market, TP and SL orders, condition 2 alone is enough.

Release funds only after all three. This rule is conservative. Imperial's own
web flow cancels resting limits by first waiting for the venue order to be gone
and every leg recorded, then closing the order. The wallet-signed path skips
that wait, which is why condition 3 exists.

## 4. Websockets

Production host: `wss://api.imperial.space`. There is no replay buffer on any
socket. On every (re)connect, subscribe again and treat the first frame as a
snapshot.

### `/ws`: positions and orders for wallets

No authentication is needed. Subscribe:

    {"type":"subscribe","wallets":["<pda1>","<pda2>"],"positionState":true,"tradeEvents":true}

* **Subscriptions:**
  * Each `subscribe` **replaces** the set; there is no unsubscribe message.
    `"wallets": []` clears the set.
  * Up to 200 wallets per connection.
  * `positionState` covers at most 25 wallets. Above that the server sends
    `{"type":"error","code":"position_state_wallet_limit","limit":25}` and
    turns `positionState` off; the other frames keep flowing.
* **Messages from the server:**

| message | when |
|---|---|
| `position_state` (`wallet`, `seq`, `positions[]`, the same rows as `GET /api/v1/positions`) | once on subscribe (snapshot; it may be empty), on every change, and about every 1 s while a position is open and its mark moved |
| `positions_updated` (`wallet`) | a position changed; refetch over REST if you are not using `positionState` |
| `orders_updated` (`wallet`) | an order was created, filled, cancelled, or a close failed; refetch `GET /api/v1/orders` |
| `order_rejected` (`wallet`, `actionId`, `reasonCode`, `error`, `errorDetails`) | a fill was refused |
| `position_closed` / `position_liquidated` (`wallet`, `lifecycleId`, `closedAt`, `trade`) | after a full close or liquidation has settled, so seconds after `positions_updated` (needs `tradeEvents`) |

* **Freshness and keepalive:**
  * Send `{"type":"ping"}` about every 25 s; the reply is `{"type":"pong"}`.
    The server does not ping you.
  * In `position_state`, mark price and PnL are updated about every second.
    Funding, fees and liquidation price are recomputed every 30 s or on any
    change.
  * `seq` increases per connection and restarts on reconnect.
  * There is no dedicated TP/SL-triggered message: a trigger appears as
    `orders_updated` followed by a position change.
  * `position_closed` and `position_liquidated` can repeat. Dedupe on
    `lifecycleId`.

### `/ws/market`: public market data

No authentication is needed.

* **Subscribe messages:** `subscribe_mark_prices` and `subscribe_funding_rates`,
  each with optional `"symbols": ["BTC"]`. Matching `unsubscribe_*` messages,
  and `ping`.
* **Delivery:** each subscribe returns a snapshot. After that only changed
  values are sent: marks are checked every 1 s, funding every 5 s.
* **Freshness:** `mark_price_update` carries `fetchedAtUnixMs`. Because only
  changes are sent, a stalled source goes quiet rather than marking itself
  stale, so judge freshness from `fetchedAtUnixMs`.
* **Slow clients:** a client that falls more than 1024 events behind is
  disconnected.
* **Armada coverage:** Armada's own mark is not on this socket. Use the
  `position_state` rows, or REST `GET /api/v1/armada/markets` and
  `/armada/orderbook`.

### Reconnecting

* Use backoff with jitter. Imperial's web client waits 0–250 ms on the first
  retry, then 500 ms doubling to a 5 s cap, ±50% jitter, and resets the
  counter once a connection has stayed up for 5 s.
* After reconnecting, re-subscribe and refetch `GET /api/v1/positions` and
  `GET /api/v1/orders`.
* The server can briefly stop sending `/ws` events without telling you. Keep
  a slow REST poll (e.g. every 30 s) as a backstop, and rely on the chain
  rules in §2 and §3, not the socket, for anything that moves funds.
