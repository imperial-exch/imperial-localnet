# Examples

`profit-withdrawal.ts` plays every role against the local bundle — user,
operator, admin and the price signer — using only `@solana/web3.js` 1.x and
`node:crypto`. It needs the bundle running with its guard (plain `../start.sh`)
and Node 20 or later.

    npm ci
    npm run profit-withdrawal          # RPC_URL=http://127.0.0.1:8899 by default

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
