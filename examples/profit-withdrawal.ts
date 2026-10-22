// A profitable Armada (imperial_sunrise) round trip on the local bundle, with
// the price guard live, then what the guard does with frames it cannot trust.
//
//   1. A user gets a passthrough UserAccount and a profile funded with USDC.
//   2. As the operator: SUNRISE_DEPOSIT (open request) -> ACCEPT at $150,
//      with a signed Lazer frame at $150 in front of the ACCEPT.
//   3. As the operator: DECREASE request -> ACCEPT at $165 with a fresh frame.
//   4. As the user: WITHDRAW_COLLATERAL of everything, profit included.
//   5. The same close with a stale frame, a frame from an unregistered key,
//      and a frame whose signature does not verify.
//
// The byte layouts it sends live in common.ts; each names the Rust struct it
// mirrors. Paths are relative to the Imperial monorepo.
//
// Run from this directory after `../start.sh` is up:  npm ci && npm run profit-withdrawal

import { Keypair, PublicKey } from "@solana/web3.js";

import {
  DECREASE,
  INCREASE,
  SEAT_CROSS,
  USD,
  PRICE,
  type LazerFrame,
  type Request,
  acceptIx,
  acceptOutcome,
  admin,
  bundle,
  clockSkewMs,
  decreaseRequestIx,
  ensureSol,
  expirySlot,
  frame,
  freshFrame,
  guardConfig,
  lazerEd25519Instruction,
  lazerPayload,
  margin,
  marginPda,
  newUser,
  operator,
  oracle,
  connection,
  releaseHeldIx,
  send,
  sendExpectingFailure,
  sunriseDepositIx,
  usd,
  usdcBalance,
  withdrawIx,
} from "./common.js";

const SOL = "SOL";
const SOL_FEED_ID: number = bundle.feeds[SOL];

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

const ENTRY = PRICE(150);
const EXIT = PRICE(165);
const SIZE = 1_000n * USD;
const COLLATERAL = 200n * USD;
// AcceptData::filled_base is 1e-9 base: size (1e-6) × 1e12 / price (1e-9).
const BASE = (SIZE * 1_000_000_000_000n) / ENTRY;

const solFrame = (price: bigint, signer = oracle) => freshFrame(SOL, price, signer);

const request = async (wallet: PublicKey, requestId: bigint, action: number): Promise<Request> => ({
  user: wallet,
  profileIndex: 0,
  requestId,
  symbol: SOL,
  seat: SEAT_CROSS,
  action,
  sizeUsd: SIZE,
  expectedPrice: action === INCREASE ? ENTRY : EXIT,
  collateral: action === INCREASE ? COLLATERAL : 0n,
  expirySlot: await expirySlot(),
});

/** Open $1,000 long SOL at $150 with $200 of collateral, priced by a fresh frame. */
async function openLong(wallet: PublicKey) {
  const open = await request(wallet, 1n, INCREASE);
  await send([sunriseDepositIx(open)], [operator]);
  const signature = await send(
    [
      lazerEd25519Instruction(solFrame(ENTRY)),
      acceptIx(open, { price: ENTRY, sizeUsd: SIZE, base: BASE }),
    ],
    [operator],
  );
  return acceptOutcome(signature);
}

/** The DECREASE request and the ACCEPT instruction that closes it at $165. */
async function closeLongIxs(wallet: PublicKey) {
  const close = await request(wallet, 2n, DECREASE);
  await send([decreaseRequestIx(close)], [operator]);
  // A close is bounded by base; its notional is the exit one, base × price.
  const exitNotional = (BASE * EXIT) / 1_000_000_000_000n;
  return acceptIx(close, { price: EXIT, sizeUsd: exitNotional, base: BASE });
}

async function main() {
  if (!(await connection.getAccountInfo(guardConfig))) {
    throw new Error("no guard config: this example needs the bundle started without --no-guard");
  }
  await ensureSol(admin.publicKey);
  await ensureSol(operator.publicKey);
  const skew = await clockSkewMs();
  console.log(`cluster clock is ${skew} ms behind wall time (frames are stamped at wall time)`);
  if (skew > 3_000 || skew < -bundle.guard.max_frame_age_ms) {
    console.log("⚠ a fresh frame reads as more than 3.5 s in the future or stale here: expect priced=0");
  }
  console.log(`guard trusts oracle ${oracle.publicKey.toBase58()}; SOL is Lazer feed ${SOL_FEED_ID}\n`);

  // 1. Happy path: both legs verified, so the profit is free at once.
  console.log("== verified open and close, then withdraw everything");
  const alice = await newUser();
  console.log("open :", await openLong(alice.wallet.publicKey));
  const closeIx = await closeLongIxs(alice.wallet.publicKey);
  const closed = await send([lazerEd25519Instruction(solFrame(EXIT)), closeIx], [operator]);
  console.log("close:", await acceptOutcome(closed));
  const m = await margin(marginPda(alice.profile)[0]);
  console.log(
    `margin collateral ${usd(m.collateral)} (deposit basis ${usd(m.depositBasis)}, held ${usd(m.held)})`,
  );
  const before = await usdcBalance(alice.profile);
  await send([withdrawIx(alice.wallet.publicKey, 0, m.collateral)], [alice.wallet]);
  const after = await usdcBalance(alice.profile);
  console.log(
    `WITHDRAW_COLLATERAL ${usd(m.collateral)}: ok — profile USDC ${usd(before)} -> ${usd(after)}, ` +
      `profit ${usd(after - 1_000n * USD)}\n`,
  );

  // 2–3. A frame the guard cannot trust never refuses the close: it runs and
  // its profit is HELD. The withdrawal is what then refuses that profit.
  const untrusted: [string, () => LazerFrame][] = [
    [
      "stale frame (10 s old; the guard admits ≤ " + bundle.guard.max_frame_age_ms + " ms)",
      () => frame(oracle, lazerPayload(BigInt(Date.now() - 10_000) * 1000n, SOL_FEED_ID, EXIT)),
    ],
    ["frame signed by a key the guard does not list", () => solFrame(EXIT, Keypair.generate())],
  ];
  for (const [label, makeFrame] of untrusted) {
    console.log(`== close with a ${label}`);
    const user = await newUser();
    await openLong(user.wallet.publicKey);
    const ix = await closeLongIxs(user.wallet.publicKey);
    const sig = await send([lazerEd25519Instruction(makeFrame()), ix], [operator]);
    const outcome = await acceptOutcome(sig);
    console.log("close ACCEPT succeeded:", outcome);
    const held = await margin(marginPda(user.profile)[0]);
    const until = new Date(Number(held.heldUntil) * 1000).toISOString();
    console.log(`margin collateral ${usd(held.collateral)}, of which ${usd(held.held)} held until ${until}`);

    const all = await sendExpectingFailure(
      [withdrawIx(user.wallet.publicKey, 0, held.collateral)],
      [user.wallet],
    );
    console.log(`withdraw everything (${usd(held.collateral)}): REJECTED — ${all}`);
    await send([withdrawIx(user.wallet.publicKey, 0, held.collateral - held.held)], [user.wallet]);
    console.log(`withdraw the unheld ${usd(held.collateral - held.held)}: ok`);
    await send([releaseHeldIx(user.profile)], [admin]);
    await send([withdrawIx(user.wallet.publicKey, 0, held.held)], [user.wallet]);
    console.log(`admin RELEASE_HELD, then withdraw the ${usd(held.held)}: ok\n`);
  }

  // 4. A signature that does not verify is not a frame the program ever sees:
  // the ed25519 precompile fails the whole transaction before it runs.
  console.log("== close with a frame claiming the oracle key but a bad signature");
  const mallory = await newUser();
  await openLong(mallory.wallet.publicKey);
  const ix = await closeLongIxs(mallory.wallet.publicKey);
  const forged = solFrame(EXIT);
  forged.signature[0] ^= 0xff;
  const err = await sendExpectingFailure([lazerEd25519Instruction(forged), ix], [operator]);
  console.log(`close transaction REJECTED — ${err}`);
  console.log("nothing in it ran; the DECREASE request is still live until accepted or expired");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
