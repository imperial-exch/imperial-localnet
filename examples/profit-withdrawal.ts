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
// Every byte layout below mirrors a Rust struct; the comment next to it names
// the file. Paths are relative to the Imperial monorepo.
//
// Run from this directory after `../start.sh` is up:  npm ci && npm run profit-withdrawal

import { createPrivateKey, sign as ed25519Sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const BUNDLE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";

const bundle = JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle.json"), "utf8"));
const loadKey = (role: string) =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(BUNDLE_DIR, "keys", `${role}.json`), "utf8"))),
  );
const admin = loadKey("admin"); // USDC mint authority, Sunrise authority
const operator = loadKey("operator"); // passthrough + Sunrise operator, and the maker
const oracle = loadKey("oracle"); // the Lazer signer the guard config trusts

const PASSTHROUGH = new PublicKey(bundle.passthrough_program);
const SUNRISE = new PublicKey(bundle.sunrise_program);
const USDC = new PublicKey(bundle.usdc_mint);
const FEE_RECIPIENT = new PublicKey(bundle.fee_recipient);
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ED25519_PROGRAM = new PublicKey("Ed25519SigVerify111111111111111111111111111");

// imperial_passthrough discriminators (programs/imperial_passthrough/src/instructions/mod.rs,
// mirrored in crates/passthrough_client/src/constants.rs)
const CREATE_USER_ACCOUNT = 2;
const SUNRISE_DEPOSIT = 66;
// imperial_sunrise discriminators (crates/imperial_core/src/sunrise/wire.rs,
// programs/imperial_sunrise/src/wire.rs)
const REQUEST_POSITION_CHANGE = 3;
const ACCEPT = 4;
const WITHDRAW_COLLATERAL = 11;
const RELEASE_HELD = 34;

const LONG = 0;
const INCREASE = 0;
const DECREASE = 1;
const HEDGE_VENUE_LIGHTER = 1;
const SEAT_CROSS = 0;

const SOL = "SOL";
const SOL_FEED_ID: number = bundle.feeds[SOL];
const USD = 1_000_000n; // µUSDC
const PRICE = (usd: number) => BigInt(Math.round(usd * 1e9)); // 9-decimal prices

const connection = new Connection(RPC_URL, "confirmed");

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program);
const u64le = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
// wire::AssetKey: the symbol's ASCII, zero-padded to 16 bytes.
const assetKey = (symbol: string) => {
  const b = Buffer.alloc(16);
  b.write(symbol, "ascii");
  return b;
};
const ata = (owner: PublicKey) =>
  pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC.toBuffer()], ATA_PROGRAM)[0];

// crates/passthrough_client/src/pda.rs
const globalSettings = pda([Buffer.from("global_settings")], PASSTHROUGH)[0];
const userAccountPda = (wallet: PublicKey) =>
  pda([Buffer.from("user"), wallet.toBuffer()], PASSTHROUGH);
const profilePda = (wallet: PublicKey, index: number) =>
  pda([Buffer.from("profile"), wallet.toBuffer(), Buffer.from([index])], PASSTHROUGH);

// crates/sunrise_client/src/pda.rs and src/guard.rs (cross seat forms)
const config = pda([Buffer.from("config")], SUNRISE)[0];
const vault = pda([Buffer.from("vault")], SUNRISE)[0];
const vaultUsdc = ata(vault);
const guardConfig = pda([Buffer.from("sunguardcfg")], SUNRISE)[0];
const feedTable = pda([Buffer.from("sunfeeds")], SUNRISE)[0];
const requestPda = (user: PublicKey, id: bigint) =>
  pda([Buffer.from("sunreq"), user.toBuffer(), u64le(id)], SUNRISE);
const marginPda = (profile: PublicKey) =>
  pda([Buffer.from("sunmargin"), profile.toBuffer()], SUNRISE);
const positionPda = (profile: PublicKey, asset: Buffer) =>
  pda([Buffer.from("sunpos"), profile.toBuffer(), asset], SUNRISE);
const fundingIndexPda = (venue: number, asset: Buffer) =>
  pda([Buffer.from("sunfund"), Buffer.from([venue]), asset], SUNRISE)[0];

// ---------------------------------------------------------------------------
// The signed price update: a Pyth Lazer payload in an ed25519 instruction
// ---------------------------------------------------------------------------

// programs/imperial_sunrise/src/lazer.rs (`parse_payload`): pyth-lazer-protocol
// `PayloadData`, little-endian. Exponent −8, best bid/ask `spreadBps` wide, and
// property 12 (feedUpdateTimestamp), without which a frame never verifies.
function lazerPayload(tsUs: bigint, feedId: number, price1e9: bigint, spreadBps = 2n): Buffer {
  const mantissa = price1e9 / 10n; // 9 decimals -> exponent -8
  const half = (mantissa * spreadBps) / 20_000n;
  const parts: Buffer[] = [];
  const u8 = (v: number) => Buffer.from([v]);
  const i64 = (v: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    return b;
  };
  const u32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return b;
  };
  const i16 = (v: number) => {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v);
    return b;
  };
  parts.push(u32(2_479_346_549)); // PAYLOAD_FORMAT_MAGIC
  parts.push(u64le(tsUs)); // timestamp_us
  parts.push(u8(3)); // channel_id (fixed_rate@200ms)
  parts.push(u8(1)); // feed_count
  parts.push(u32(feedId)); // feed_id
  parts.push(u8(5)); // property_count
  parts.push(u8(0), i64(mantissa)); // 0 Price
  parts.push(u8(1), i64(mantissa - half)); // 1 BestBid
  parts.push(u8(2), i64(mantissa + half)); // 2 BestAsk
  parts.push(u8(4), i16(-8)); // 4 Exponent
  parts.push(u8(12), u8(1), u64le(tsUs)); // 12 FeedUpdateTimestamp: flag + u64
  return Buffer.concat(parts);
}

// RFC 8032 ed25519 over the payload bytes, with the signer's 32-byte seed.
function ed25519(signer: Keypair, message: Buffer): Buffer {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(signer.secretKey.subarray(0, 32)),
  ]);
  return ed25519Sign(null, message, createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }));
}

interface LazerFrame {
  signer: PublicKey;
  signature: Buffer;
  payload: Buffer;
}

const frame = (signer: Keypair, payload: Buffer): LazerFrame => ({
  signer: signer.publicKey,
  signature: ed25519(signer, payload),
  payload,
});

// crates/sunrise_client/src/guard.rs (`lazer_ed25519_instruction`): the frame
// rides in the ed25519 precompile instruction's OWN data, and every
// instruction-index field is u16::MAX ("this instruction"). It must sit
// IMMEDIATELY before the ACCEPT that it prices.
//
//   [0]      u8   number of signatures (1)
//   [1]      u8   padding
//   [2..16]  7×u16 offsets: signature_offset, signature_ix (0xFFFF),
//                 public_key_offset, public_key_ix (0xFFFF),
//                 message_offset, message_size, message_ix (0xFFFF)
//   [16..48]  signer public key
//   [48..112] signature
//   [112..]   payload
function lazerEd25519Instruction(f: LazerFrame): TransactionInstruction {
  const SELF = 0xffff;
  const header = 2 + 14;
  const pk = header;
  const sig = pk + 32;
  const msg = sig + 64;
  const offsets = Buffer.alloc(14);
  [sig, SELF, pk, SELF, msg, f.payload.length, SELF].forEach((v, i) =>
    offsets.writeUInt16LE(v, i * 2),
  );
  return new TransactionInstruction({
    programId: ED25519_PROGRAM,
    keys: [],
    data: Buffer.concat([Buffer.from([1, 0]), offsets, f.signer.toBuffer(), f.signature, f.payload]),
  });
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

// programs/imperial_passthrough/src/instructions/create_user_account.rs
function createUserAccountIx(wallet: PublicKey, payer: PublicKey) {
  const [userAccount, bump] = userAccountPda(wallet);
  return new TransactionInstruction({
    programId: PASSTHROUGH,
    keys: [
      meta(userAccount, true),
      meta(wallet, false),
      meta(payer, true, true),
      meta(SystemProgram.programId, false),
    ],
    data: Buffer.from([CREATE_USER_ACCOUNT, bump, 0, 0, 0, 0, 0, 0, 0]),
  });
}

// spl-associated-token-account CreateIdempotent (1) and spl-token MintTo (7).
function createAtaIx(payer: PublicKey, owner: PublicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      meta(payer, true, true),
      meta(ata(owner), true),
      meta(owner, false),
      meta(USDC, false),
      meta(SystemProgram.programId, false),
      meta(TOKEN_PROGRAM, false),
    ],
    data: Buffer.from([1]),
  });
}

function mintUsdcIx(destination: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [meta(USDC, true), meta(destination, true), meta(admin.publicKey, false, true)],
    data: Buffer.concat([Buffer.from([7]), u64le(amount)]),
  });
}

interface Request {
  user: PublicKey;
  profileIndex: number;
  requestId: bigint;
  action: number;
  sizeUsd: bigint;
  expectedPrice: bigint;
  collateral: bigint;
  expirySlot: bigint;
}

// crates/imperial_core/src/sunrise/wire.rs: RequestPositionChangeData (64
// bytes), RequestBuilderData (8), RequestTermsData (8) — REQUEST_PAYLOAD_LEN 80.
function requestBody(r: Request, maintenanceBps: number, profileBump: number): Buffer {
  const body = Buffer.alloc(80);
  assetKey(SOL).copy(body, 0); // asset_key [16]
  body.writeBigUInt64LE(r.sizeUsd, 16); // size_usd (µUSD)
  body.writeBigUInt64LE(r.expectedPrice, 24); // expected_price (1e-9)
  body.writeBigUInt64LE(r.expirySlot, 32); // expiry_slot
  body.writeBigUInt64LE(r.requestId, 40); // request_id
  body.writeUInt16LE(50, 48); // slippage_bps
  body.writeUInt8(LONG, 50); // side
  body.writeUInt8(r.action, 51); // action
  body.writeUInt8(HEDGE_VENUE_LIGHTER, 52); // requested_hedge_venue
  body.writeUInt8(0, 53); // flags
  body.writeUInt8(requestPda(r.user, r.requestId)[1], 54); // request_bump
  body.writeUInt8(SEAT_CROSS, 55); // margin_seat
  body.writeBigUInt64LE(r.collateral, 56); // collateral (µUSDC)
  // 64..72 builder block: builder_fee_bps u16, padding [2], builder_id u32 — none
  body.writeUInt16LE(maintenanceBps, 72); // terms.market_maintenance_bps
  body.writeUInt8(r.profileIndex, 74); // terms.profile_index
  body.writeUInt8(profileBump, 75); // terms.profile_bump; 76..80 padding
  return body;
}

// programs/imperial_passthrough/src/instructions/mod.rs SunriseDepositData
// (112 bytes) and sunrise_deposit.rs for the accounts (built by
// crates/passthrough_client/src/instructions.rs `build_sunrise_deposit_ix`): the
// operator opens the request and the passthrough signs for the profile, so
// `amount` moves profile USDC -> Sunrise vault in the same instruction.
function sunriseDepositIx(r: Request): TransactionInstruction {
  const profile = profilePda(r.user, r.profileIndex)[0];
  const asset = assetKey(SOL);
  const head = Buffer.alloc(48);
  head.writeUInt8(r.profileIndex, 0); // profile_index, then 7 bytes padding
  head.writeBigUInt64LE(r.collateral, 8); // amount
  head.writeBigUInt64LE(0n, 16); // fee_amount (ignored on chain)
  head.writeBigUInt64LE(BigInt(bundle.market_maintenance_bps), 24); // market_maintenance_bps (u64)
  // 32..40 _reserved, 40..42 _padding2, 42..44 builder_fee_bps, 44..48 builder_id
  const request = requestBody(r, 0, 0).subarray(0, 64); // the passthrough fills the terms
  return new TransactionInstruction({
    programId: PASSTHROUGH,
    keys: [
      meta(globalSettings, false),
      meta(userAccountPda(r.user)[0], false),
      meta(profile, true),
      meta(r.user, false),
      meta(operator.publicKey, true, true),
      meta(ata(profile), true),
      meta(ata(FEE_RECIPIENT), true),
      meta(config, false),
      meta(vault, true),
      meta(vaultUsdc, true),
      meta(requestPda(r.user, r.requestId)[0], true),
      meta(positionPda(profile, asset)[0], false),
      meta(TOKEN_PROGRAM, false),
      meta(SystemProgram.programId, false),
      meta(SUNRISE, false),
      // an INCREASE also carries the seat's margin account and the market's
      // funding index (which may not exist yet: an absent one accrues nothing)
      meta(marginPda(profile)[0], false),
      meta(fundingIndexPda(HEDGE_VENUE_LIGHTER, asset), false),
    ],
    data: Buffer.concat([Buffer.from([SUNRISE_DEPOSIT]), head, request]),
  });
}

// crates/sunrise_client/src/instructions/raw.rs (`request_position_change`): a
// DECREASE moves no money, so it is operator-direct and the profile does not sign.
function decreaseRequestIx(r: Request): TransactionInstruction {
  const [profile, profileBump] = profilePda(r.user, r.profileIndex);
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [
      meta(operator.publicKey, true, true),
      meta(config, false),
      meta(vault, true),
      meta(vaultUsdc, true),
      meta(profile, false),
      meta(ata(profile), true),
      meta(r.user, false),
      meta(requestPda(r.user, r.requestId)[0], true),
      meta(positionPda(profile, assetKey(SOL))[0], false),
      meta(TOKEN_PROGRAM, false),
      meta(SystemProgram.programId, false),
    ],
    data: Buffer.concat([
      Buffer.from([REQUEST_POSITION_CHANGE]),
      requestBody(r, 0, profileBump),
    ]),
  });
}

interface Fill {
  price: bigint;
  sizeUsd: bigint;
  base: bigint;
}

// programs/imperial_sunrise/src/wire.rs AcceptData (64 bytes), accounts per
// src/instructions/settle.rs, then the guard tail
// [guard_config, feed_table, instructions_sysvar] (crates/sunrise_client/src/guard.rs).
function acceptIx(user: PublicKey, profileIndex: number, requestId: bigint, fill: Fill) {
  const profile = profilePda(user, profileIndex)[0];
  const asset = assetKey(SOL);
  const [margin, marginBump] = marginPda(profile);
  const [position, positionBump] = positionPda(profile, asset);
  const data = Buffer.alloc(64);
  data.writeBigUInt64LE(requestId, 0); // venue_trade_id [32]: any non-zero id
  data.writeBigUInt64LE(fill.price, 32); // fill_price (1e-9)
  data.writeBigUInt64LE(fill.sizeUsd, 40); // filled_size_usd (µUSD)
  data.writeBigUInt64LE(fill.base, 48); // filled_base (1e-9 base)
  data.writeUInt8(HEDGE_VENUE_LIGHTER, 56); // hedge_venue
  data.writeUInt8(positionBump, 57); // position_bump
  data.writeUInt8(marginBump, 58); // margin_bump
  data.writeUInt16LE(bundle.market_maintenance_bps, 59); // market_maintenance: u16 bps…
  data.writeUInt8(1, 61); // …then 1 = present; 62..64 padding
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [
      meta(operator.publicKey, true, true),
      meta(config, false),
      meta(vault, true),
      meta(requestPda(user, requestId)[0], true),
      meta(margin, true),
      meta(position, true),
      meta(user, false),
      meta(operator.publicKey, false), // maker: the bundle's config names the operator
      meta(operator.publicKey, true), // rent_payer: whoever paid for the request
      meta(SystemProgram.programId, false),
      meta(fundingIndexPda(HEDGE_VENUE_LIGHTER, asset), true),
      meta(guardConfig, false),
      meta(feedTable, false),
      meta(SYSVAR_INSTRUCTIONS_PUBKEY, false),
    ],
    data: Buffer.concat([Buffer.from([ACCEPT]), data]),
  });
}

// programs/imperial_sunrise/src/instructions/withdraw.rs: seven accounts, then
// the guard config (writable: profit is charged to its rolling caps). Without
// the guard config only principal can leave. No frame is read here.
function withdrawIx(user: PublicKey, profileIndex: number, amount: bigint) {
  const profile = profilePda(user, profileIndex)[0];
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [
      meta(user, false, true),
      meta(config, false),
      meta(vault, true),
      meta(vaultUsdc, true),
      meta(marginPda(profile)[0], true),
      meta(ata(profile), true),
      meta(TOKEN_PROGRAM, false),
      meta(guardConfig, true),
    ],
    data: Buffer.concat([Buffer.from([WITHDRAW_COLLATERAL]), u64le(amount)]),
  });
}

// src/instructions/guard.rs (`process_release_held`): the authority frees
// held profit at once; it joins the deposit basis.
function releaseHeldIx(profile: PublicKey) {
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [meta(admin.publicKey, false, true), meta(config, false), meta(marginPda(profile)[0], true)],
    data: Buffer.from([RELEASE_HELD]),
  });
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

// programs/imperial_sunrise/src/state/margin.rs MarginAccount (128 bytes) and
// src/state/guard.rs MarginExtension right after it.
async function margin(profile: PublicKey) {
  const info = await connection.getAccountInfo(marginPda(profile)[0]);
  if (!info) throw new Error("no margin account");
  const d = info.data;
  const collateral = d.readBigUInt64LE(72);
  const depositBasis = d.readBigUInt64LE(128);
  const now = BigInt(Math.floor(Date.now() / 1000));
  // MarginExtension::active_held: the two running tranches, never more than
  // the profit the account actually carries above its basis.
  const tranche = (amount: bigint, until: bigint) => (now < until ? amount : 0n);
  const raw =
    tranche(d.readBigUInt64LE(136), d.readBigInt64LE(144)) +
    tranche(d.readBigUInt64LE(168), d.readBigInt64LE(176));
  const aboveBasis = collateral > depositBasis ? collateral - depositBasis : 0n;
  return {
    collateral,
    depositBasis,
    held: raw < aboveBasis ? raw : aboveBasis,
    heldUntil: d.readBigInt64LE(144),
  };
}

async function usdcBalance(owner: PublicKey): Promise<bigint> {
  const b = await connection.getTokenAccountBalance(ata(owner));
  return BigInt(b.value.amount);
}

const usd = (micro: bigint) => `$${(Number(micro) / 1e6).toFixed(6)}`;

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(...ixs);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

// The codes this example runs into. Sunrise's are programs/imperial_sunrise/src/error.rs;
// the ed25519 precompile's are agave's PrecompileError.
const KNOWN_ERRORS: Record<string, string> = {
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x59": "Sunrise ProfitHeld (89)",
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x5a": "Sunrise ProfitCapExceeded (90)",
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x5e": "Sunrise GuardAccountsRequired (94)",
  "Ed25519SigVerify111111111111111111111111111:0x2": "ed25519 precompile InvalidSignature",
};

/** What a transaction fails with, or throws if it succeeds. */
async function sendExpectingFailure(ixs: TransactionInstruction[], signers: Keypair[]) {
  // `send` prepends a compute-budget instruction, so error indices are +1.
  const programs = [ComputeBudgetProgram.programId, ...ixs.map((ix) => ix.programId)];
  try {
    await send(ixs, signers);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failed = message.match(/Error processing Instruction (\d+): custom program error: (0x[0-9a-f]+)/);
    const logs = e instanceof SendTransactionError ? (e.logs ?? []) : [];
    const programLog = logs.find((l) => l.startsWith("Program log:"))?.slice("Program log: ".length);
    if (!failed) return message.split("\n").slice(0, 2).join(" ");
    const program = programs[Number(failed[1])]?.toBase58() ?? "?";
    const name = KNOWN_ERRORS[`${program}:${failed[2]}`] ?? `${program} error ${failed[2]}`;
    return `instruction ${failed[1]} failed: ${name}${programLog ? ` — "${programLog}"` : ""}`;
  }
  throw new Error("expected the transaction to fail");
}

/** `priced` and `held` from the ACCEPT's `SunriseAccept` log line. */
async function acceptOutcome(signature: string) {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const line = tx?.meta?.logMessages?.find((l) => l.includes("SunriseAccept"));
  const field = (name: string) => line?.match(new RegExp(` ${name}=(\\d+)`))?.[1];
  return { priced: field("priced"), held: BigInt(field("held") ?? "0") };
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

const ENTRY = PRICE(150);
const EXIT = PRICE(165);
const SIZE = 1_000n * USD;
const COLLATERAL = 200n * USD;
// AcceptData::filled_base is 1e-9 base: size (1e-6) × 1e12 / price (1e-9).
const BASE = (SIZE * 1_000_000_000_000n) / ENTRY;

const freshFrame = (price: bigint, signer = oracle) =>
  frame(signer, lazerPayload(BigInt(Date.now()) * 1000n, SOL_FEED_ID, price));

async function expirySlot() {
  const slot = await connection.getSlot("confirmed");
  return BigInt(slot + Math.min(60, bundle.max_expiry_slots - 1));
}

/** A fresh wallet with a UserAccount and a profile holding 1,000 USDC. */
async function newUser() {
  const wallet = Keypair.generate();
  const profile = profilePda(wallet.publicKey, 0)[0];
  await send(
    [
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: wallet.publicKey,
        lamports: 100_000_000,
      }),
      createUserAccountIx(wallet.publicKey, admin.publicKey),
      createAtaIx(admin.publicKey, profile),
      mintUsdcIx(ata(profile), 1_000n * USD),
    ],
    [admin],
  );
  return { wallet, profile };
}

/** Open $1,000 long SOL at $150 with $200 of collateral, priced by a fresh frame. */
async function openLong(wallet: PublicKey) {
  const open: Request = {
    user: wallet,
    profileIndex: 0,
    requestId: 1n,
    action: INCREASE,
    sizeUsd: SIZE,
    expectedPrice: ENTRY,
    collateral: COLLATERAL,
    expirySlot: await expirySlot(),
  };
  await send([sunriseDepositIx(open)], [operator]);
  const signature = await send(
    [
      lazerEd25519Instruction(freshFrame(ENTRY)),
      acceptIx(wallet, 0, 1n, { price: ENTRY, sizeUsd: SIZE, base: BASE }),
    ],
    [operator],
  );
  return acceptOutcome(signature);
}

/** The DECREASE request and the ACCEPT instruction that closes it at $165. */
async function closeLongIxs(wallet: PublicKey) {
  const close: Request = {
    user: wallet,
    profileIndex: 0,
    requestId: 2n,
    action: DECREASE,
    sizeUsd: SIZE,
    expectedPrice: EXIT,
    collateral: 0n,
    expirySlot: await expirySlot(),
  };
  await send([decreaseRequestIx(close)], [operator]);
  // A close is bounded by base; its notional is the exit one, base × price.
  const exitNotional = (BASE * EXIT) / 1_000_000_000_000n;
  return acceptIx(wallet, 0, 2n, { price: EXIT, sizeUsd: exitNotional, base: BASE });
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
  const closed = await send([lazerEd25519Instruction(freshFrame(EXIT)), closeIx], [operator]);
  console.log("close:", await acceptOutcome(closed));
  const m = await margin(alice.profile);
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
    ["frame signed by a key the guard does not list", () => freshFrame(EXIT, Keypair.generate())],
  ];
  for (const [label, makeFrame] of untrusted) {
    console.log(`== close with a ${label}`);
    const user = await newUser();
    await openLong(user.wallet.publicKey);
    const ix = await closeLongIxs(user.wallet.publicKey);
    const sig = await send([lazerEd25519Instruction(makeFrame()), ix], [operator]);
    const outcome = await acceptOutcome(sig);
    console.log("close ACCEPT succeeded:", outcome);
    const held = await margin(user.profile);
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
  const forged = freshFrame(EXIT);
  forged.signature[0] ^= 0xff;
  const err = await sendExpectingFailure([lazerEd25519Instruction(forged), ix], [operator]);
  console.log(`close transaction REJECTED — ${err}`);
  console.log("nothing in it ran; the DECREASE request is still live until accepted or expired");
}

async function ensureSol(key: PublicKey) {
  if ((await connection.getBalance(key)) < 10_000_000_000) {
    const sig = await connection.requestAirdrop(key, 100_000_000_000);
    await connection.confirmTransaction(sig, "confirmed");
  }
}

/** Wall time minus the cluster clock, which is what frame freshness is measured against. */
async function clockSkewMs() {
  const info = await connection.getAccountInfo(
    new PublicKey("SysvarC1ock11111111111111111111111111111111"),
  );
  const unixTimestamp = info!.data.readBigInt64LE(32);
  return Date.now() - Number(unixTimestamp) * 1000;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
