// Shared by the examples: the bundle's keys and addresses, the byte layouts of
// every instruction they send, and the account fields they read.
//
// Every byte layout below mirrors a Rust struct; the comment next to it names
// the file. Paths are relative to the Imperial monorepo.

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

export const bundle = JSON.parse(readFileSync(join(BUNDLE_DIR, "bundle.json"), "utf8"));
const loadKey = (role: string) =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(join(BUNDLE_DIR, "keys", `${role}.json`), "utf8"))),
  );
export const admin = loadKey("admin"); // USDC mint authority, Sunrise authority
export const operator = loadKey("operator"); // passthrough + Sunrise operator, and the maker
export const oracle = loadKey("oracle"); // the Lazer signer the guard config trusts

export const PASSTHROUGH = new PublicKey(bundle.passthrough_program);
export const SUNRISE = new PublicKey(bundle.sunrise_program);
export const USDC = new PublicKey(bundle.usdc_mint);
export const FEE_RECIPIENT = new PublicKey(bundle.fee_recipient);
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const ED25519_PROGRAM = new PublicKey("Ed25519SigVerify111111111111111111111111111");

// imperial_passthrough discriminators (programs/imperial_passthrough/src/instructions/mod.rs,
// mirrored in crates/passthrough_client/src/constants.rs)
export const CREATE_USER_ACCOUNT = 2;
export const SUNRISE_DEPOSIT = 66;
// imperial_sunrise discriminators (crates/imperial_core/src/sunrise/wire.rs,
// programs/imperial_sunrise/src/wire.rs)
export const REQUEST_POSITION_CHANGE = 3;
export const ACCEPT = 4;
export const WITHDRAW_COLLATERAL = 11;
export const SET_FUNDING_RATE = 12;
export const BEGIN_LIQUIDATION = 19;
export const FINALIZE_LIQUIDATION = 20;
export const SETTLE_NATIVE_LIQUIDATION = 27;
export const RELEASE_HELD = 34;
export const SET_MARKET_RISK = 38;

export const LONG = 0;
export const INCREASE = 0;
export const DECREASE = 1;
export const HEDGE_VENUE = 1;
// wire::margin_seat
export const SEAT_CROSS = 0;
export const SEAT_ISOLATED = 1;

export const USD = 1_000_000n; // µUSDC
export const PRICE = (usd: number) => BigInt(Math.round(usd * 1e9)); // 9-decimal prices

export const connection = new Connection(RPC_URL, "confirmed");

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program);
export const u64le = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
// wire::AssetKey: the symbol's ASCII, zero-padded to 16 bytes.
export const assetKey = (symbol: string) => {
  const b = Buffer.alloc(16);
  b.write(symbol, "ascii");
  return b;
};
export const ata = (owner: PublicKey) =>
  pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), USDC.toBuffer()], ATA_PROGRAM)[0];

// crates/passthrough_client/src/pda.rs
export const globalSettings = pda([Buffer.from("global_settings")], PASSTHROUGH)[0];
export const userAccountPda = (wallet: PublicKey) =>
  pda([Buffer.from("user"), wallet.toBuffer()], PASSTHROUGH);
export const profilePda = (wallet: PublicKey, index: number) =>
  pda([Buffer.from("profile"), wallet.toBuffer(), Buffer.from([index])], PASSTHROUGH);

// crates/sunrise_client/src/pda.rs and src/guard.rs. A cross seat is
// ["sunmargin", profile]; an isolated seat adds its asset key as a third seed,
// and its position adds "iso" as a fourth.
export const config = pda([Buffer.from("config")], SUNRISE)[0];
export const vault = pda([Buffer.from("vault")], SUNRISE)[0];
export const vaultUsdc = ata(vault);
export const guardConfig = pda([Buffer.from("sunguardcfg")], SUNRISE)[0];
export const feedTable = pda([Buffer.from("sunfeeds")], SUNRISE)[0];
export const requestPda = (user: PublicKey, id: bigint) =>
  pda([Buffer.from("sunreq"), user.toBuffer(), u64le(id)], SUNRISE);
export const marginPda = (profile: PublicKey, seat = SEAT_CROSS, asset?: Buffer) =>
  seat === SEAT_CROSS
    ? pda([Buffer.from("sunmargin"), profile.toBuffer()], SUNRISE)
    : pda([Buffer.from("sunmargin"), profile.toBuffer(), asset!], SUNRISE);
export const positionPda = (profile: PublicKey, asset: Buffer, seat = SEAT_CROSS) =>
  seat === SEAT_CROSS
    ? pda([Buffer.from("sunpos"), profile.toBuffer(), asset], SUNRISE)
    : pda([Buffer.from("sunpos"), profile.toBuffer(), asset, Buffer.from("iso")], SUNRISE);
export const fundingIndexPda = (venue: number, asset: Buffer) =>
  pda([Buffer.from("sunfund"), Buffer.from([venue]), asset], SUNRISE);
export const primeBindingPda = (profile: PublicKey, asset: Buffer) =>
  pda([Buffer.from("sunprimeseat"), profile.toBuffer(), asset], SUNRISE)[0];
export const liquidationPda = (margin: PublicKey, revision: bigint) =>
  pda([Buffer.from("sunliq"), margin.toBuffer(), u64le(revision)], SUNRISE)[0];
export const liquidationPolicyPda = (venue: number, asset: Buffer) =>
  pda([Buffer.from("sunliqrisk"), Buffer.from([venue]), asset], SUNRISE)[0];
export const portfolioRisk = pda([Buffer.from("sunportfolio")], SUNRISE)[0];

// ---------------------------------------------------------------------------
// The signed price update: a Pyth Lazer payload in an ed25519 instruction
// ---------------------------------------------------------------------------

// programs/imperial_sunrise/src/lazer.rs (`parse_payload`): pyth-lazer-protocol
// `PayloadData`, little-endian. Exponent −8, best bid/ask `spreadBps` wide, and
// property 12 (feedUpdateTimestamp), without which a frame never verifies.
export function lazerPayload(
  tsUs: bigint,
  feedId: number,
  price1e9: bigint,
  spreadBps = 2n,
): Buffer {
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

export interface LazerFrame {
  signer: PublicKey;
  signature: Buffer;
  payload: Buffer;
}

export const frame = (signer: Keypair, payload: Buffer): LazerFrame => ({
  signer: signer.publicKey,
  signature: ed25519(signer, payload),
  payload,
});

/** A frame stamped now, for `symbol` at `price`, signed by the oracle unless told otherwise. */
export const freshFrame = (symbol: string, price: bigint, signer = oracle) =>
  frame(signer, lazerPayload(BigInt(Date.now()) * 1000n, bundle.feeds[symbol], price));

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
export function lazerEd25519Instruction(f: LazerFrame): TransactionInstruction {
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

export const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

// programs/imperial_passthrough/src/instructions/create_user_account.rs
export function createUserAccountIx(wallet: PublicKey, payer: PublicKey) {
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
export function createAtaIx(payer: PublicKey, owner: PublicKey) {
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

export function mintUsdcIx(destination: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [meta(USDC, true), meta(destination, true), meta(admin.publicKey, false, true)],
    data: Buffer.concat([Buffer.from([7]), u64le(amount)]),
  });
}

export interface Request {
  user: PublicKey;
  profileIndex: number;
  requestId: bigint;
  symbol: string;
  seat: number;
  action: number;
  sizeUsd: bigint;
  expectedPrice: bigint;
  collateral: bigint;
  expirySlot: bigint;
}

/** The request's profile, and its seat's margin account and position. */
export function seatAccounts(r: Pick<Request, "user" | "profileIndex" | "symbol" | "seat">) {
  const [profile, profileBump] = profilePda(r.user, r.profileIndex);
  const asset = assetKey(r.symbol);
  return {
    profile,
    profileBump,
    asset,
    margin: marginPda(profile, r.seat, asset),
    position: positionPda(profile, asset, r.seat),
  };
}

// crates/imperial_core/src/sunrise/wire.rs: RequestPositionChangeData (64
// bytes), RequestBuilderData (8), RequestTermsData (8) — REQUEST_PAYLOAD_LEN 80.
export function requestBody(r: Request, maintenanceBps: number, profileBump: number): Buffer {
  const body = Buffer.alloc(80);
  assetKey(r.symbol).copy(body, 0); // asset_key [16]
  body.writeBigUInt64LE(r.sizeUsd, 16); // size_usd (µUSD)
  body.writeBigUInt64LE(r.expectedPrice, 24); // expected_price (1e-9)
  body.writeBigUInt64LE(r.expirySlot, 32); // expiry_slot
  body.writeBigUInt64LE(r.requestId, 40); // request_id
  body.writeUInt16LE(50, 48); // slippage_bps
  body.writeUInt8(LONG, 50); // side
  body.writeUInt8(r.action, 51); // action
  body.writeUInt8(HEDGE_VENUE, 52); // requested_hedge_venue
  body.writeUInt8(0, 53); // flags
  body.writeUInt8(requestPda(r.user, r.requestId)[1], 54); // request_bump
  body.writeUInt8(r.seat, 55); // margin_seat
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
export function sunriseDepositIx(r: Request): TransactionInstruction {
  const { profile, asset, margin, position } = seatAccounts(r);
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
      meta(position[0], false),
      meta(TOKEN_PROGRAM, false),
      meta(SystemProgram.programId, false),
      meta(SUNRISE, false),
      // an isolated seat also carries its (absent) Prime binding
      ...(r.seat === SEAT_ISOLATED ? [meta(primeBindingPda(profile, asset), false)] : []),
      // an INCREASE also carries the seat's margin account and the market's
      // funding index (which may not exist yet: an absent one accrues nothing,
      // and carries no leverage tier)
      meta(margin[0], false),
      meta(fundingIndexPda(HEDGE_VENUE, asset)[0], false),
    ],
    data: Buffer.concat([Buffer.from([SUNRISE_DEPOSIT]), head, request]),
  });
}

// crates/sunrise_client/src/instructions/raw.rs (`request_position_change`): a
// DECREASE moves no money, so it is operator-direct and the profile does not sign.
export function decreaseRequestIx(r: Request): TransactionInstruction {
  const { profile, profileBump, position } = seatAccounts(r);
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
      meta(position[0], false),
      meta(TOKEN_PROGRAM, false),
      meta(SystemProgram.programId, false),
    ],
    data: Buffer.concat([
      Buffer.from([REQUEST_POSITION_CHANGE]),
      requestBody(r, 0, profileBump),
    ]),
  });
}

export interface Fill {
  price: bigint;
  sizeUsd: bigint;
  base: bigint;
}

// programs/imperial_sunrise/src/wire.rs AcceptData (64 bytes), accounts per
// src/instructions/settle.rs, then the guard tail
// [guard_config, feed_table, instructions_sysvar] (crates/sunrise_client/src/guard.rs).
export function acceptIx(r: Request, fill: Fill) {
  const { asset, margin, position } = seatAccounts(r);
  const data = Buffer.alloc(64);
  data.writeBigUInt64LE(r.requestId, 0); // venue_trade_id [32]: any non-zero id
  data.writeBigUInt64LE(fill.price, 32); // fill_price (1e-9)
  data.writeBigUInt64LE(fill.sizeUsd, 40); // filled_size_usd (µUSD)
  data.writeBigUInt64LE(fill.base, 48); // filled_base (1e-9 base)
  data.writeUInt8(HEDGE_VENUE, 56); // hedge_venue
  data.writeUInt8(position[1], 57); // position_bump
  data.writeUInt8(margin[1], 58); // margin_bump
  data.writeUInt16LE(bundle.market_maintenance_bps, 59); // market_maintenance: u16 bps…
  data.writeUInt8(1, 61); // …then 1 = present; 62..64 padding
  return new TransactionInstruction({
    programId: SUNRISE,
    keys: [
      meta(operator.publicKey, true, true),
      meta(config, false),
      meta(vault, true),
      meta(requestPda(r.user, r.requestId)[0], true),
      meta(margin[0], true),
      meta(position[0], true),
      meta(r.user, false),
      meta(operator.publicKey, false), // maker: the bundle's config names the operator
      meta(operator.publicKey, true), // rent_payer: whoever paid for the request
      meta(SystemProgram.programId, false),
      meta(fundingIndexPda(HEDGE_VENUE, asset)[0], true),
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
export function withdrawIx(user: PublicKey, profileIndex: number, amount: bigint) {
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
export function releaseHeldIx(profile: PublicKey) {
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
export async function margin(address: PublicKey) {
  const info = await connection.getAccountInfo(address);
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
    grossNotional: d.readBigUInt64LE(80),
    openPositions: d.readBigUInt64LE(88),
    revision: d.readBigUInt64LE(120), // _reserved[1]
    liquidationReserved: (d.readBigUInt64LE(112) & 2n) !== 0n, // _reserved[0] bit 2
    depositBasis,
    held: raw < aboveBasis ? raw : aboveBasis,
    heldUntil: d.readBigInt64LE(144),
  };
}

// programs/imperial_sunrise/src/state/position.rs Position (144 bytes).
export async function position(address: PublicKey) {
  const info = await connection.getAccountInfo(address);
  if (!info) return null;
  const d = info.data;
  return {
    side: d[2],
    isIsolated: d[4],
    sizeUsd: d.readBigUInt64LE(88),
    entryPrice: d.readBigUInt64LE(96),
    openedAtSlot: d.readBigUInt64LE(104),
    hedgedBase: d.readBigUInt64LE(112),
    // the native liquidation terms ACCEPT pinned, packed in _reserved[0]:
    // non-zero when the position settles through SETTLE_NATIVE_LIQUIDATION
    nativeTerms: d.readBigUInt64LE(136),
  };
}

export async function usdcBalance(owner: PublicKey): Promise<bigint> {
  const b = await connection.getTokenAccountBalance(ata(owner));
  return BigInt(b.value.amount);
}

export const usd = (micro: bigint) =>
  `${micro < 0n ? "-" : ""}$${(Number(micro < 0n ? -micro : micro) / 1e6).toFixed(6)}`;

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(...ixs);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

// The codes the examples run into. Sunrise's are programs/imperial_sunrise/src/error.rs;
// the ed25519 precompile's are agave's PrecompileError.
const KNOWN_ERRORS: Record<string, string> = {
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x32": "Sunrise AccountNotLiquidatable (50)",
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x51": "Sunrise LiquidationIntentMismatch (81)",
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x56": "Sunrise PrimeOperationUnsupported (86)",
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x59": "Sunrise ProfitHeld (89)",
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x5a": "Sunrise ProfitCapExceeded (90)",
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x5e": "Sunrise GuardAccountsRequired (94)",
  "ARmavNtb6xs7SpH3geahw434fwTrVw5BSvJf36CAbWKB:0x68": "Sunrise PortfolioRiskRequired (104)",
  "Ed25519SigVerify111111111111111111111111111:0x2": "ed25519 precompile InvalidSignature",
};

/** Whether the program would accept `ixs` now, without sending them. */
export async function simulates(ixs: TransactionInstruction[], signers: Keypair[]): Promise<boolean> {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(...ixs);
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  return (await connection.simulateTransaction(tx)).value.err === null;
}

/** What a transaction fails with, or throws if it succeeds. */
export async function sendExpectingFailure(ixs: TransactionInstruction[], signers: Keypair[]) {
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

/** The program log lines of a confirmed transaction. */
export async function logLines(signature: string): Promise<string[]> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  return tx?.meta?.logMessages ?? [];
}

/** `priced` and `held` from the ACCEPT's `SunriseAccept` log line. */
export async function acceptOutcome(signature: string) {
  const line = (await logLines(signature)).find((l) => l.includes("SunriseAccept"));
  const field = (name: string) => line?.match(new RegExp(` ${name}=(\\d+)`))?.[1];
  return { priced: field("priced"), held: BigInt(field("held") ?? "0") };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export async function expirySlot() {
  const slot = await connection.getSlot("confirmed");
  return BigInt(slot + Math.min(60, bundle.max_expiry_slots - 1));
}

/** A fresh wallet with a UserAccount and a profile holding `usdc` µUSDC. */
export async function newUser(usdc = 1_000n * USD) {
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
      mintUsdcIx(ata(profile), usdc),
    ],
    [admin],
  );
  return { wallet, profile };
}

export async function ensureSol(key: PublicKey) {
  if ((await connection.getBalance(key)) < 10_000_000_000) {
    const sig = await connection.requestAirdrop(key, 100_000_000_000);
    await connection.confirmTransaction(sig, "confirmed");
  }
}

/** The cluster clock: what frame freshness and liquidation timestamps are measured against. */
export async function clusterClock() {
  const info = await connection.getAccountInfo(
    new PublicKey("SysvarC1ock11111111111111111111111111111111"),
  );
  return { slot: info!.data.readBigUInt64LE(0), unixTimestamp: info!.data.readBigInt64LE(32) };
}

/** Wall time minus the cluster clock, which is what frame freshness is measured against. */
export async function clockSkewMs() {
  return Date.now() - Number((await clusterClock()).unixTimestamp) * 1000;
}
