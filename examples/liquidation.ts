// Armada (imperial_sunrise) liquidations on the local bundle: an isolated seat
// under a 250x market tier, and a cross seat, each pushed through its
// maintenance line, with the exact instructions the operator signs and what
// a program watching the user's accounts sees.
//
//   0. As the operator and the admin: create BTC's funding index
//      (SET_FUNDING_RATE at rate 0) and give it mainnet's tier, 250x at 20 bps
//      maintenance (SET_MARKET_RISK).
//   1. Isolated: a user with a $1,000 SOL cross long opens a 250x BTC long on
//      an isolated seat. A tiered isolated position settles through
//      SETTLE_NATIVE_LIQUIDATION (BEGIN_LIQUIDATION refuses it): one cent above
//      the line it is refused, at the line it settles, and the cross seat is
//      untouched.
//   2. Cross: a user with SOL and BTC longs on one cross seat. The line comes
//      from the program itself (simulated BEGINs), since a cross seat's
//      maintenance nets its legs through the portfolio risk account. BEGIN is
//      refused one cent above the line and succeeds at it; FINALIZE closes BOTH
//      positions and leaves the remainder in the cross margin account.
//
// Every byte layout below mirrors a Rust struct; the comment next to it names
// the file. Paths are relative to the Imperial monorepo.
//
// Run from this directory after `../start.sh` is up:  npm ci && npm run liquidation

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

import {
  BEGIN_LIQUIDATION,
  FINALIZE_LIQUIDATION,
  HEDGE_VENUE,
  INCREASE,
  PRICE,
  SEAT_CROSS,
  SEAT_ISOLATED,
  SETTLE_NATIVE_LIQUIDATION,
  SET_FUNDING_RATE,
  SET_MARKET_RISK,
  SUNRISE,
  USD,
  type Request,
  acceptIx,
  admin,
  assetKey,
  clusterClock,
  config,
  connection,
  ensureSol,
  expirySlot,
  freshFrame,
  fundingIndexPda,
  guardConfig,
  lazerEd25519Instruction,
  liquidationPda,
  liquidationPolicyPda,
  logLines,
  margin,
  meta,
  newUser,
  operator,
  portfolioRisk,
  position,
  seatAccounts,
  send,
  sendExpectingFailure,
  simulates,
  sunriseDepositIx,
  usd,
  usdcBalance,
  vault,
  withdrawIx,
} from "./common.js";

const BTC = "BTC";
const SOL = "SOL";
const TIER = { maxLeverage: 250, maintenanceBps: 20 }; // docs/armada/market-tiers.csv
const CENT = 10_000_000n; // $0.01 at 9 decimals

// ---------------------------------------------------------------------------
// Market setup
// ---------------------------------------------------------------------------

// programs/imperial_sunrise/src/wire.rs SetFundingRateData (32 bytes), accounts
// [operator (signer), config, funding_index (w), system] per
// src/instructions/funding.rs. The first publication creates the accumulator.
function setFundingRateIx(symbol: string, ratePerSec1e12: bigint) {
  const [index, bump] = fundingIndexPda(HEDGE_VENUE, assetKey(symbol));
  const data = Buffer.alloc(32);
  assetKey(symbol).copy(data, 0); // asset_key [16]
  data.writeBigInt64LE(ratePerSec1e12, 16); // rate_per_sec_1e12
  data.writeUInt8(HEDGE_VENUE, 24); // hedge_venue
  data.writeUInt8(bump, 25); // bump; 26..32 padding
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [
      meta(operator.publicKey, true, true),
      meta(config, false),
      meta(index, true),
      meta(SystemProgram.programId, false),
    ],
    data: Buffer.concat([Buffer.from([SET_FUNDING_RATE]), data]),
  });
}

// wire.rs SetMarketRiskData (32 bytes), accounts [authority (signer), config,
// funding_index (w)] per src/instructions/market_risk.rs. `expected_version` is
// the index's tier version (FundingIndex._reserved[1]), a compare-and-swap.
function setMarketRiskIx(symbol: string, expectedVersion: bigint) {
  const data = Buffer.alloc(32);
  assetKey(symbol).copy(data, 0); // asset_key [16]
  data.writeBigUInt64LE(expectedVersion, 16); // expected_version
  data.writeUInt16LE(TIER.maxLeverage, 24); // max_leverage
  data.writeUInt16LE(TIER.maintenanceBps, 26); // maintenance_bps
  data.writeUInt8(HEDGE_VENUE, 28); // hedge_venue; 29..32 padding
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [
      meta(admin.publicKey, false, true),
      meta(config, false),
      meta(fundingIndexPda(HEDGE_VENUE, assetKey(symbol))[0], true),
    ],
    data: Buffer.concat([Buffer.from([SET_MARKET_RISK]), data]),
  });
}

// src/state/funding.rs FundingIndex (96 bytes): the tier is _reserved[0],
// tagged 0x5254 in its top 16 bits, its version _reserved[1].
async function marketTier(symbol: string) {
  const info = await connection.getAccountInfo(fundingIndexPda(HEDGE_VENUE, assetKey(symbol))[0]);
  if (!info) return null;
  const word = info.data.readBigUInt64LE(64);
  const tagged = word >> 48n === 0x5254n;
  return {
    maxLeverage: tagged ? Number((word >> 16n) & 0xffffn) : 0,
    maintenanceBps: tagged ? Number(word & 0xffffn) : 0,
    version: info.data.readBigUInt64LE(72),
  };
}

async function seedTier(symbol: string) {
  if (!(await marketTier(symbol))) await send([setFundingRateIx(symbol, 0n)], [operator]);
  let tier = (await marketTier(symbol))!;
  if (tier.maxLeverage !== TIER.maxLeverage || tier.maintenanceBps !== TIER.maintenanceBps) {
    await send([setMarketRiskIx(symbol, tier.version)], [admin]);
    tier = (await marketTier(symbol))!;
  }
  const index = fundingIndexPda(HEDGE_VENUE, assetKey(symbol))[0].toBase58();
  console.log(
    `${symbol} funding index ${index}: tier ${tier.maxLeverage}x at ${tier.maintenanceBps} bps ` +
      `maintenance (version ${tier.version}), funding rate 0`,
  );
}

// ---------------------------------------------------------------------------
// Opening positions
// ---------------------------------------------------------------------------

type User = Awaited<ReturnType<typeof newUser>>;

/** SUNRISE_DEPOSIT then ACCEPT (with a signed frame) of a long on `seat`. */
async function openLong(
  user: User,
  requestId: bigint,
  symbol: string,
  seat: number,
  sizeUsd: bigint,
  price: bigint,
  collateral: bigint,
) {
  const r: Request = {
    user: user.wallet.publicKey,
    profileIndex: 0,
    requestId,
    symbol,
    seat,
    action: INCREASE,
    sizeUsd,
    expectedPrice: price,
    collateral,
    expirySlot: await expirySlot(),
  };
  await send([sunriseDepositIx(r)], [operator]);
  const base = (sizeUsd * 1_000_000_000_000n) / price;
  await send(
    [lazerEd25519Instruction(freshFrame(symbol, price)), acceptIx(r, { price, sizeUsd, base })],
    [operator],
  );
  return seatAccounts(r);
}

// ---------------------------------------------------------------------------
// The maintenance line, as the program computes it
// ---------------------------------------------------------------------------

interface Leg {
  sizeUsd: bigint;
  entryPrice: bigint;
  maintenanceBps: number;
}

// src/instructions/mod.rs: realized_pnl (truncating), notional_at_mark
// (size × mark / entry, floored), and the maintenance requirement
// ceil(Σ notional × bps / 10_000). Liquidatable when equity < requirement,
// strictly. Longs only; funding is zero here (rate 0).
function isLiquidatable(collateral: bigint, legs: Leg[], marks: bigint[]) {
  let equity = collateral;
  let scaled = 0n;
  legs.forEach((leg, i) => {
    equity += ((marks[i] - leg.entryPrice) * leg.sizeUsd) / leg.entryPrice;
    scaled += ((leg.sizeUsd * marks[i]) / leg.entryPrice) * BigInt(leg.maintenanceBps);
  });
  return equity < (scaled + 9_999n) / 10_000n;
}

/** The highest whole-cent mark of leg `i` at which the seat is liquidatable. */
function liquidationLine(collateral: bigint, legs: Leg[], marks: bigint[], i: number) {
  const at = (cents: bigint) => marks.map((m, j) => (j === i ? cents * CENT : m));
  let lo = 1n;
  let hi = legs[i].entryPrice / CENT;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (isLiquidatable(collateral, legs, at(mid))) lo = mid;
    else hi = mid - 1n;
  }
  return lo * CENT;
}

// ---------------------------------------------------------------------------
// The liquidation instructions (operator-signed)
// ---------------------------------------------------------------------------

// wire.rs BeginLiquidationData (24 bytes) then one LiquidationQuote (24 bytes)
// per position; accounts per src/instructions/liquidation.rs
// (`process_begin_liquidation`), built by
// crates/sunrise_client/src/instructions/liquidation.rs `begin_liquidation`:
//   [operator (signer, w), config, margin (w), intent (w), system,
//    position × N, funding_index × N, liquidation_policy × N, portfolio_risk]
// The intent is ["sunliq", margin, expected_revision]. A market with no
// funding index or no liquidation policy still passes its address. The
// portfolio risk account (["sunportfolio"]) is required once a seat holds two
// or more positions (PortfolioRiskRequired, 104).
function beginLiquidationIx(
  marginAccount: PublicKey,
  revision: bigint,
  legs: { position: PublicKey; symbol: string; mark: bigint }[],
) {
  const head = Buffer.alloc(24);
  head.writeBigUInt64LE(revision, 0); // expected_revision
  head.writeBigUInt64LE(0n, 8); // _reserved (ignored)
  head.writeUInt8(legs.length, 16); // position_count; 17..24 padding
  const quotes = legs.map((leg) => {
    const q = Buffer.alloc(24);
    q.writeBigUInt64LE(leg.mark, 0); // mark (1e-9)
    q.writeBigUInt64LE(0n, 8); // policy_version: 0 = the market has no policy
    q.writeUInt16LE(0, 16); // reserve_bps; 18..24 padding
    return q;
  });
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [
      meta(operator.publicKey, true, true),
      meta(config, false),
      meta(marginAccount, true),
      meta(liquidationPda(marginAccount, revision), true),
      meta(SystemProgram.programId, false),
      ...legs.map((leg) => meta(leg.position, false)),
      ...legs.map((leg) => meta(fundingIndexPda(HEDGE_VENUE, assetKey(leg.symbol))[0], false)),
      ...legs.map((leg) => meta(liquidationPolicyPda(HEDGE_VENUE, assetKey(leg.symbol)), false)),
      meta(portfolioRisk, false),
    ],
    data: Buffer.concat([Buffer.from([BEGIN_LIQUIDATION]), head, ...quotes]),
  });
}

// `process_finalize_liquidation`, built by `finalize_liquidation`: no data
// beyond the discriminator.
//   [operator (signer, w), config, vault (w), margin (w), intent (w),
//    position (w) × N, guard_config]
function finalizeLiquidationIx(marginAccount: PublicKey, intent: PublicKey, positions: PublicKey[]) {
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [
      meta(operator.publicKey, true, true),
      meta(config, false),
      meta(vault, true),
      meta(marginAccount, true),
      meta(intent, true),
      ...positions.map((p) => meta(p, true)),
      meta(guardConfig, false),
    ],
    data: Buffer.from([FINALIZE_LIQUIDATION]),
  });
}

// wire.rs VenueFirstLiquidationData (80 bytes); accounts per
// src/instructions/prime_venue_first.rs (`settle_venue_first`), built by
// `settle_native_liquidation`:
//   [operator (signer, w), config, vault (w), margin (w), receipt (w),
//    position (w), system, funding_index]
// One instruction does BEGIN's checks and FINALIZE's settlement. The receipt
// is ["sunliq", margin, expected_revision], as BEGIN's intent is.
function settleNativeLiquidationIx(
  marginAccount: PublicKey,
  positionAccount: PublicKey,
  symbol: string,
  terms: {
    revision: bigint;
    openedAtSlot: bigint;
    observedSlot: bigint;
    observedTs: bigint;
    mark: bigint;
    closedBase: bigint;
    collateral: bigint;
  },
) {
  const data = Buffer.alloc(80);
  data.writeBigUInt64LE(terms.revision, 0); // expected_revision
  data.writeBigUInt64LE(terms.openedAtSlot, 8); // opened_at_slot
  data.writeBigUInt64LE(terms.observedSlot, 16); // observed_slot (≤ now)
  data.writeBigInt64LE(terms.observedTs, 24); // observed_ts (≤ now)
  data.writeBigUInt64LE(terms.mark, 32); // mark (1e-9)
  // 40..56 _reserved [u64; 2] (ignored: funding comes from the index)
  data.writeBigUInt64LE(0n, 56); // debt_at_trigger: 0 outside Prime
  data.writeBigUInt64LE(terms.closedBase, 64); // closed_base = position.hedged_base
  data.writeBigUInt64LE(terms.collateral, 72); // expected_collateral = margin.collateral
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [
      meta(operator.publicKey, true, true),
      meta(config, false),
      meta(vault, true),
      meta(marginAccount, true),
      meta(liquidationPda(marginAccount, terms.revision), true),
      meta(positionAccount, true),
      meta(SystemProgram.programId, false),
      meta(fundingIndexPda(HEDGE_VENUE, assetKey(symbol))[0], false),
    ],
    data: Buffer.concat([Buffer.from([SETTLE_NATIVE_LIQUIDATION]), data]),
  });
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const price = (p: bigint) => `$${(Number(p) / 1e9).toFixed(2)}`;

function printInstruction(name: string, ix: TransactionInstruction, labels: string[]) {
  console.log(`  ${name}: program ${ix.programId.toBase58()}`);
  console.log(`    data (${ix.data.length} bytes) ${ix.data.toString("hex")}`);
  ix.keys.forEach((k, i) => {
    const flags = `${k.isSigner ? "s" : "-"}${k.isWritable ? "w" : "-"}`;
    console.log(`    ${String(i).padStart(2)} ${flags} ${k.pubkey.toBase58().padEnd(44)} ${labels[i] ?? ""}`);
  });
}

async function printLiquidationLogs(signature: string) {
  for (const line of await logLines(signature)) {
    if (/SunriseLiquidation|SunriseLiquidate /.test(line)) console.log(`    ${line}`);
  }
}

// src/state/liquidation.rs LiquidationIntent (152 bytes): the permanent
// receipt BEGIN (or SETTLE_NATIVE_LIQUIDATION) creates at ["sunliq", margin,
// revision] and FINALIZE marks settled.
async function printReceipt(address: PublicKey) {
  const d = (await connection.getAccountInfo(address))!.data;
  const equity = d.readBigUInt64LE(136) + (d.readBigInt64LE(144) << 64n);
  console.log(
    `  receipt ${address.toBase58()}: settled=${d[3]} venue_first=${d[5]} ` +
      `collateral ${usd(d.readBigUInt64LE(96))}, equity at mark ${usd(equity)}, ` +
      `maintenance ${usd(d.readBigUInt64LE(128))}, gross at mark ${usd(d.readBigUInt64LE(120))}, ` +
      `fee ${usd(d.readBigUInt64LE(112))}, residual ${usd(d.readBigUInt64LE(104))}`,
  );
}

async function snapshot(user: User, cross: PublicKey, crossPositions: PublicKey[]) {
  const m = await margin(cross);
  const sizes = await Promise.all(crossPositions.map(async (p) => (await position(p))?.sizeUsd ?? 0n));
  return {
    profileUsdc: await usdcBalance(user.profile),
    crossCollateral: m.collateral,
    crossOpen: m.openPositions,
    crossSizes: sizes,
  };
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

async function isolatedSeat() {
  console.log("== 1. isolated seat: BTC long at 250x, beside a SOL cross long");
  const alice = await newUser();
  const solEntry = PRICE(150);
  const btcEntry = PRICE(100_000);
  const cross = await openLong(alice, 1n, SOL, SEAT_CROSS, 1_000n * USD, solEntry, 200n * USD);
  const iso = await openLong(alice, 2n, BTC, SEAT_ISOLATED, 24_000n * USD, btcEntry, 100n * USD);
  const isoMargin = iso.margin[0];
  const isoPosition = iso.position[0];

  const before = await snapshot(alice, cross.margin[0], [cross.position[0]]);
  const seat = await margin(isoMargin);
  const pos = (await position(isoPosition))!;
  console.log(
    `isolated seat ${isoMargin.toBase58()}: deposited $100.000000, collateral after the open fee ` +
      `${usd(seat.collateral)}, position $${Number(pos.sizeUsd) / 1e6} at ${price(pos.entryPrice)} ` +
      `(${Number(pos.sizeUsd / (seat.collateral / 1000n)) / 1000}x)`,
  );
  console.log(
    `cross seat: collateral ${usd(before.crossCollateral)}, SOL $${Number(before.crossSizes[0]) / 1e6}; ` +
      `profile USDC ${usd(before.profileUsdc)}`,
  );

  const legs = [{ sizeUsd: pos.sizeUsd, entryPrice: pos.entryPrice, maintenanceBps: TIER.maintenanceBps }];
  const line = liquidationLine(seat.collateral, legs, [btcEntry], 0);
  console.log(`maintenance line: liquidatable at BTC ≤ ${price(line)}\n`);

  const begin = beginLiquidationIx(isoMargin, seat.revision, [
    { position: isoPosition, symbol: BTC, mark: line },
  ]);
  console.log(
    `BEGIN_LIQUIDATION at ${price(line)}: REJECTED — ${await sendExpectingFailure([begin], [operator])}`,
  );
  console.log("  (a position opened under a market tier settles only through SETTLE_NATIVE_LIQUIDATION)");

  const settleAt = async (mark: bigint) => {
    const clock = await clusterClock();
    return settleNativeLiquidationIx(isoMargin, isoPosition, BTC, {
      revision: seat.revision,
      openedAtSlot: pos.openedAtSlot,
      observedSlot: clock.slot,
      observedTs: clock.unixTimestamp,
      mark,
      closedBase: pos.hedgedBase,
      collateral: seat.collateral,
    });
  };
  const above = line + CENT;
  console.log(
    `SETTLE_NATIVE_LIQUIDATION at ${price(above)} (1¢ above): REJECTED — ` +
      (await sendExpectingFailure([await settleAt(above)], [operator])),
  );
  const ix = await settleAt(line);
  const signature = await send([ix], [operator]);
  console.log(`SETTLE_NATIVE_LIQUIDATION at ${price(line)}: ok ${signature}`);
  printInstruction("SETTLE_NATIVE_LIQUIDATION", ix, [
    "operator",
    "config",
    "vault",
    "margin (isolated BTC seat)",
    "receipt [sunliq, margin, revision]",
    "position (BTC, iso)",
    "system program",
    "funding index (BTC)",
  ]);
  console.log("  logs:");
  await printLiquidationLogs(signature);
  await printReceipt(liquidationPda(isoMargin, seat.revision));

  const after = await margin(isoMargin);
  const crossAfter = await snapshot(alice, cross.margin[0], [cross.position[0]]);
  console.log(
    `isolated seat: collateral ${usd(seat.collateral)} -> ${usd(after.collateral)} ` +
      `(lost ${usd(seat.collateral - after.collateral)}), open positions ${after.openPositions}, ` +
      `position account ${(await position(isoPosition)) ? "still open" : "closed"}`,
  );
  console.log(
    `cross seat: collateral ${usd(before.crossCollateral)} -> ${usd(crossAfter.crossCollateral)}, ` +
      `SOL $${Number(before.crossSizes[0]) / 1e6} -> $${Number(crossAfter.crossSizes[0]) / 1e6}; ` +
      `profile USDC ${usd(before.profileUsdc)} -> ${usd(crossAfter.profileUsdc)}\n`,
  );
}

async function crossSeat() {
  console.log("== 2. cross seat: SOL and BTC longs on one balance");
  const bob = await newUser();
  const solEntry = PRICE(150);
  const btcEntry = PRICE(100_000);
  const sol = await openLong(bob, 1n, SOL, SEAT_CROSS, 1_000n * USD, solEntry, 100n * USD);
  const btc = await openLong(bob, 2n, BTC, SEAT_CROSS, 3_500n * USD, btcEntry, 100n * USD);
  const crossMargin = sol.margin[0];
  const positions = [sol.position[0], btc.position[0]];

  const seat = await margin(crossMargin);
  const profileBefore = await usdcBalance(bob.profile);
  console.log(
    `cross seat ${crossMargin.toBase58()}: deposited $200.000000, collateral after the open fees ` +
      `${usd(seat.collateral)}, gross $${Number(seat.grossNotional) / 1e6} ` +
      `(SOL $1000 at $150, BTC $3500 at $100000)`,
  );

  const quotes = (btcMark: bigint) => [
    { position: positions[0], symbol: SOL, mark: solEntry },
    { position: positions[1], symbol: BTC, mark: btcMark },
  ];
  const liquidatableAt = (btcMark: bigint) =>
    simulates([beginLiquidationIx(crossMargin, seat.revision, quotes(btcMark))], [operator]);
  let lo = 1n;
  let hi = btcEntry / CENT;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (await liquidatableAt(mid * CENT)) lo = mid;
    else hi = mid - 1n;
  }
  const line = lo * CENT;
  console.log(`maintenance line with SOL at $150 (simulated BEGINs): liquidatable at BTC ≤ ${price(line)}\n`);
  const above = line + CENT;
  console.log(
    `BEGIN_LIQUIDATION at BTC ${price(above)} (1¢ above): REJECTED — ` +
      (await sendExpectingFailure([beginLiquidationIx(crossMargin, seat.revision, quotes(above))], [operator])),
  );

  const begin = beginLiquidationIx(crossMargin, seat.revision, quotes(line));
  const intent = liquidationPda(crossMargin, seat.revision);
  const begun = await send([begin], [operator]);
  console.log(`BEGIN_LIQUIDATION at BTC ${price(line)}: ok ${begun}`);
  printInstruction("BEGIN_LIQUIDATION", begin, [
    "operator",
    "config",
    "margin (cross seat)",
    "intent [sunliq, margin, revision]",
    "system program",
    "position SOL",
    "position BTC",
    "funding index SOL (absent here: accrues nothing)",
    "funding index BTC",
    "liquidation policy SOL (absent: policy_version 0)",
    "liquidation policy BTC (absent: policy_version 0)",
    "portfolio risk [sunportfolio]",
  ]);
  console.log("  logs:");
  await printLiquidationLogs(begun);
  const reserved = await margin(crossMargin);
  console.log(
    `  margin between the two: liquidation_reserved=${reserved.liquidationReserved}, ` +
      `revision ${seat.revision} -> ${reserved.revision}, collateral ${usd(reserved.collateral)}, ` +
      `positions still open: ${reserved.openPositions}`,
  );

  const finalize = finalizeLiquidationIx(crossMargin, intent, positions);
  const finalized = await send([finalize], [operator]);
  console.log(`FINALIZE_LIQUIDATION: ok ${finalized}`);
  printInstruction("FINALIZE_LIQUIDATION", finalize, [
    "operator",
    "config",
    "vault",
    "margin (cross seat)",
    "intent",
    "position SOL",
    "position BTC",
    "guard config",
  ]);
  console.log("  logs:");
  await printLiquidationLogs(finalized);
  await printReceipt(intent);

  const after = await margin(crossMargin);
  const closed = await Promise.all(positions.map(async (p) => !(await position(p))));
  console.log(
    `cross seat: collateral ${usd(seat.collateral)} -> ${usd(after.collateral)} ` +
      `(lost ${usd(seat.collateral - after.collateral)}), open positions ${after.openPositions}, ` +
      `SOL position ${closed[0] ? "closed" : "open"}, BTC position ${closed[1] ? "closed" : "open"}`,
  );
  await send([withdrawIx(bob.wallet.publicKey, 0, after.collateral)], [bob.wallet]);
  console.log(
    `WITHDRAW_COLLATERAL ${usd(after.collateral)} (user-signed): profile USDC ` +
      `${usd(profileBefore)} -> ${usd(await usdcBalance(bob.profile))}`,
  );
}

async function main() {
  if (!(await connection.getAccountInfo(guardConfig))) {
    throw new Error("no guard config: this example needs the bundle started without --no-guard");
  }
  await ensureSol(admin.publicKey);
  await ensureSol(operator.publicKey);
  await seedTier(BTC);
  console.log();
  await isolatedSeat();
  await crossSeat();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
