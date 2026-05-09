/**
 * Jetton TX builder — produces TonConnect-compatible message payloads so the
 * publisher's wallet (NOT our hot wallet) signs token deploys and liquidity
 * transactions.
 *
 *   Reference implementation: https://github.com/ton-blockchain/minter
 *   (the React frontend that powers https://minter.ton.org)
 *   Reference contract:        https://github.com/ton-blockchain/minter-contract
 *
 *   This file is a 1:1 port of the deploy logic from `src/lib/jetton-minter.ts`
 *   and `src/lib/contract-deployer.ts` of the minter repo, adapted to:
 *     • run server-side under Node (so `app-store.service.ts` can hand the
 *       browser a ready-to-sign TonConnect message),
 *     • emit `@ton/core` Cells instead of the legacy `ton` package types.
 *
 *   The compiled FunC contract hex is embedded inline (constants
 *   `JETTON_MINTER_CODE_HEX` / `JETTON_WALLET_CODE_HEX`) so deploys work
 *   without dropping any BoC files on the server.
 *
 *  Operations exposed to callers:
 *
 *  1) `buildDeployAndMintMessage` — the "deploy master + mint full supply
 *     to user" message that the user signs with their TonConnect wallet.
 *     After it lands, the master exists on-chain with `admin = userWallet`
 *     and the user's jetton wallet holds `amountToMint` Jettons. Single
 *     TonConnect message, mirrors `minter.ton.org`'s deploy flow exactly.
 *
 *  2) `deriveJettonWalletAddress` — deterministic `(master, owner) →
 *     jetton-wallet address`, same `data` layout as the audited contract.
 *
 *  3) `buildJettonTransferMessage` / `buildTonTransferMessage` — used by
 *     the LP-init flow to fund the platform vault, with text-comment
 *     forward payloads so the TON monitor can pair the two legs.
 *
 * Returns objects in the `{ address, amount, payload, stateInit? }` shape
 * expected by `tonConnectUI.sendTransaction(...).messages[]`. All numeric
 * fields are strings (TonConnect wire format).
 */

import { createHash } from "crypto";
import {
  Address,
  beginCell,
  Builder,
  Cell,
  contractAddress,
  Dictionary,
  storeStateInit,
  toNano,
} from "@ton/core";
import { runtimeConfig } from "./runtime-config.service";
import { BillingService } from "./billing.service";

// ─────────────────────────────────────────────────────────────────────────────
// Embedded compiled contracts.
//
// These are the exact hex BoCs ship by https://github.com/ton-blockchain/minter
// (file: src/lib/contracts/jetton-{minter,wallet}.compiled.json) — the same
// audited code that powers https://minter.ton.org. To regenerate, clone
// https://github.com/ton-blockchain/minter-contract and run `npm run build`.
// ─────────────────────────────────────────────────────────────────────────────

const MINTER_CONTRACT_REPO_URL = "https://github.com/ton-blockchain/minter-contract";

const JETTON_MINTER_CODE_HEX =
  "b5ee9c72c1020d0100029c000000000d00120018002a006b007000bc0139018f02110218027b0114ff00f4a413f4bcf2c80b01020162050202037a600403001faf16f6a2687d007d206a6a183faa9040007dadbcf6a2687d007d206a6a183618fc1400b82a1009aa0a01e428027d012c678b00e78b666491646580897a007a00658064fc80383a6465816503e5ffe4e8400202cc07060093b5f0508806e0a84026a8280790a009f404b19e2c039e2d99924591960225e801e80196019241f200e0e9919605940f97ff93a0ef003191960ab19e2ca009f4042796d625999992e3f60102f1d906380492f81f000e8698180b8d8492f81f07d207d2018fd0018b8eb90fd0018fd001801698fe99ff6a2687d007d206a6a18400aa9385d47199a9a9b1b289a6382f97024817d207d006a18106840306b90fd001812881a282178050a502819e428027d012c678b666664f6aa7041083deecbef29385d718140b0801a682102c76b9735270bae30235373723c0038e1a335035c705f2e04903fa403059c85004fa0258cf16ccccc9ed54e03502c0048e185124c705f2e049d4304300c85004fa0258cf16ccccc9ed54e05f05840ff2f00901fe365f03820898968015a015bcf2e04b02fa40d3003095c821cf16c9916de28210d1735400708018c8cb055005cf1624fa0214cb6a13cb1f14cb3f23fa443070ba8e33f828440370542013541403c85004fa0258cf1601cf16ccc922c8cb0112f400f400cb00c9f9007074c8cb02ca07cbffc9d0cf16966c227001cb01e2f4000a000ac98040fb0001c036373701fa00fa40f82854120670542013541403c85004fa0258cf1601cf16ccc922c8cb0112f400f400cb00c9f9007074c8cb02ca07cbffc9d05006c705f2e04aa1034545c85004fa0258cf16ccccc9ed5401fa403020d70b01c300915be30d0c003e8210d53276db708010c8cb055003cf1622fa0212cb6acb1fcb3fc98042fb002eedfd83";

const JETTON_WALLET_CODE_HEX =
  "b5ee9c72c1021101000323000000000d001200220027002c00700075007a00e8016801a801e2025e02af02b402bf0114ff00f4a413f4bcf2c80b010201620302001ba0f605da89a1f401f481f481a8610202cc0e0402012006050083d40106b90f6a2687d007d207d206a1802698fc1080bc6a28ca9105d41083deecbef09dd0958f97162e99f98fd001809d02811e428027d012c678b00e78b6664f6aa40201200c07020120090800d73b51343e803e903e90350c01f4cffe803e900c145468549271c17cb8b049f0bffcb8b08160824c4b402805af3cb8b0e0841ef765f7b232c7c572cfd400fe8088b3c58073c5b25c60063232c14933c59c3e80b2dab33260103ec01004f214013e809633c58073c5b3327b552002f73b51343e803e903e90350c0234cffe80145468017e903e9014d6f1c1551cdb5c150804d50500f214013e809633c58073c5b33248b232c044bd003d0032c0327e401c1d3232c0b281f2fff274140371c1472c7cb8b0c2be80146a2860822625a019ad822860822625a028062849e5c412440e0dd7c138c34975c2c0600b0a007cc30023c200b08e218210d53276db708010c8cb055008cf165004fa0216cb6a12cb1f12cb3fc972fb0093356c21e203c85004fa0258cf1601cf16ccc9ed5400705279a018a182107362d09cc8cb1f5230cb3f58fa025007cf165007cf16c9718010c8cb0524cf165006fa0215cb6a14ccc971fb001024102301f1503d33ffa00fa4021f001ed44d0fa00fa40fa40d4305136a1522ac705f2e2c128c2fff2e2c254344270542013541403c85004fa0258cf1601cf16ccc922c8cb0112f400f400cb00c920f9007074c8cb02ca07cbffc9d004fa40f40431fa0020d749c200f2e2c4778018c8cb055008cf1670fa0217cb6b13cc80d009e8210178d4519c8cb1f19cb3f5007fa0222cf165006cf1625fa025003cf16c95005cc2391729171e25008a813a08209c9c380a014bcf2e2c504c98040fb001023c85004fa0258cf1601cf16ccc9ed540201d4100f00113e910c1c2ebcb8536000c30831c02497c138007434c0c05c6c2544d7c0fc03383e903e900c7e800c5c75c87e800c7e800c1cea6d0000b4c7e08403e29fa954882ea54c4d167c0278208405e3514654882ea58c511100fc02b80d60841657c1ef2ea4d67c02f817c12103fcbc200475cc36";

let _minterCode: Cell | null = null;
let _walletCode: Cell | null = null;

function jettonMinterCode(): Cell {
  if (!_minterCode) _minterCode = Cell.fromBoc(Buffer.from(JETTON_MINTER_CODE_HEX, "hex"))[0];
  return _minterCode;
}

function jettonWalletCode(): Cell {
  if (!_walletCode) _walletCode = Cell.fromBoc(Buffer.from(JETTON_WALLET_CODE_HEX, "hex"))[0];
  return _walletCode;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIP-3 op codes / constants — same names as in `minter/src/lib/jetton-minter.ts`.
// ─────────────────────────────────────────────────────────────────────────────

const OP_MINT = 21;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_TRANSFER = 0xf8a7ea5;
const ONCHAIN_CONTENT_PREFIX = 0x00;
const SNAKE_PREFIX = 0x00;

/**
 * Deploy gas budget, identical to minter.ton.org. Covers:
 *   • the deploy storage fees of the Jetton master,
 *   • forwarding 0.2 TON to the user's jetton wallet (deploy + mint).
 */
export const JETTON_DEPLOY_GAS_NANO = toNano("0.25");
const JETTON_FORWARD_TO_USER_WALLET = toNano("0.2");
const JETTON_INTERNAL_FORWARD_TON = toNano("0.001");

// ─────────────────────────────────────────────────────────────────────────────
// Public types.
// ─────────────────────────────────────────────────────────────────────────────

export interface TonConnectMessage {
  address: string;
  amount: string;          // nanoTON, decimal string
  payload?: string;        // base64 BoC of message body
  stateInit?: string;      // base64 BoC of state init (deploys)
}

export interface TonConnectTx {
  validUntil: number;
  messages: TonConnectMessage[];
}

/**
 * On-chain TIP-64 metadata fields. Only `name` and `symbol` are required.
 * `decimals` is stored as a *string* (per the TEP-64 spec). `image` should
 * be an HTTPS URL pointing to a 256×256 PNG; we fall back to no image if
 * the publisher hasn't uploaded a logo yet.
 */
export type JettonOnchainMetadata = {
  name: string;
  symbol: string;
  decimals?: string;
  description?: string;
  image?: string;
  image_data?: string;
};

const ONCHAIN_KEY_ENCODING: { [k in keyof JettonOnchainMetadata]: BufferEncoding | undefined } = {
  name: "utf8",
  symbol: "utf8",
  decimals: "utf8",
  description: "utf8",
  image: "ascii",
  image_data: undefined,
};

/** TIP-3 metadata key → 256-bit sha256, used as the dict key. */
function metadataKeyHash(key: string): bigint {
  const buf = createHash("sha256").update(key).digest();
  return BigInt("0x" + buf.toString("hex"));
}

// ─────────────────────────────────────────────────────────────────────────────
// On-chain metadata builder — same as `buildJettonOnchainMetadata` in the
// minter.ton.org sources. Each value is snake-encoded (max 1023 bits per
// cell, with refs for overflow).
// ─────────────────────────────────────────────────────────────────────────────

function snakeEncode(buf: Buffer): Cell {
  const CELL_MAX_BYTES = Math.floor((1023 - 8) / 8); // first cell carries the 8-bit snake prefix
  const root = beginCell().storeUint(SNAKE_PREFIX, 8);
  let cur: Builder = root;
  let remaining = buf;
  while (remaining.length > 0) {
    const chunk = remaining.subarray(0, CELL_MAX_BYTES);
    cur.storeBuffer(chunk);
    remaining = remaining.subarray(chunk.length);
    if (remaining.length > 0) {
      const next = beginCell();
      cur.storeRef(next);
      cur = next;
    }
  }
  return root.endCell();
}

function buildJettonOnchainMetadataCell(meta: JettonOnchainMetadata): Cell {
  const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());

  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === "") continue;
    const enc = ONCHAIN_KEY_ENCODING[k as keyof JettonOnchainMetadata];
    if (enc === undefined && k !== "image_data") {
      throw new Error(`Unsupported onchain metadata key: ${k}`);
    }
    const buf = Buffer.from(String(v), (enc as BufferEncoding) || "utf8");
    dict.set(metadataKeyHash(k), snakeEncode(buf));
  }

  return beginCell()
    .storeUint(ONCHAIN_CONTENT_PREFIX, 8)
    .storeDict(dict)
    .endCell();
}

// ─────────────────────────────────────────────────────────────────────────────
// Initial data + mint body — direct ports of `initData()` and `mintBody()`.
// ─────────────────────────────────────────────────────────────────────────────

function jettonInitData(owner: Address, content: Cell): Cell {
  return beginCell()
    .storeCoins(0)                  // total_supply (master tracks it on-chain)
    .storeAddress(owner)            // admin = publisher's wallet
    .storeRef(content)              // on-chain metadata cell
    .storeRef(jettonWalletCode())   // jetton wallet code (same as minter.ton.org)
    .endCell();
}

function jettonMintBody(opts: {
  owner: Address;
  jettonValue: bigint;          // amount minted (atomic units)
  forwardToJWallet: bigint;     // TON forwarded into the user's jetton wallet for deploy
  queryId?: bigint;
}): Cell {
  const queryId = opts.queryId ?? 0n;
  const internalTransfer = beginCell()
    .storeUint(OP_INTERNAL_TRANSFER, 32)
    .storeUint(0n, 64)
    .storeCoins(opts.jettonValue)
    .storeAddress(null)                         // from_address = master (null)
    .storeAddress(opts.owner)                   // response_destination = owner
    .storeCoins(JETTON_INTERNAL_FORWARD_TON)
    .storeBit(false)                            // forward_payload empty
    .endCell();

  return beginCell()
    .storeUint(OP_MINT, 32)
    .storeUint(queryId, 64)
    .storeAddress(opts.owner)                   // to_address (mint recipient)
    .storeCoins(opts.forwardToJWallet)
    .storeRef(internalTransfer)
    .endCell();
}

function textCommentCell(text: string): Cell {
  return beginCell().storeUint(0, 32).storeStringTail(text).endCell();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public APIs.
// ─────────────────────────────────────────────────────────────────────────────

/** Always true — contract code is embedded; no external BoCs to load. */
export function isJettonInfraReady(): boolean {
  try {
    jettonMinterCode();
    jettonWalletCode();
    return true;
  } catch {
    return false;
  }
}

export interface BuildDeployAndMintParams {
  userWalletAddress: string;
  /**
   * On-chain TIP-64 metadata — stored inside the master contract itself
   * (no external HTTPS dependency). Wallets read this directly via
   * `get_jetton_data`. Minimum required: `name` + `symbol`.
   */
  metadata: JettonOnchainMetadata;
  /**
   * Total supply to mint to the publisher in atomic units (i.e. already
   * multiplied by `10 ** decimals`). The whole supply lands in the
   * publisher's jetton wallet immediately after deploy.
   */
  amountToMint: bigint;
  /** Optional override for the mint body queryId (default 0). */
  queryId?: bigint;
  /** Optional gas/value override (default = JETTON_DEPLOY_GAS_NANO). */
  attachedTonNano?: bigint;
}

export interface BuildDeployAndMintResult {
  jettonMasterAddress: string;
  message: TonConnectMessage;
  validUntil: number;
}

/**
 * Build the single TonConnect message that:
 *   1) Deploys the Jetton master with `admin = userWallet` and the embedded
 *      TIP-3 wallet code (same as minter.ton.org).
 *   2) Carries an inline mint body that pre-mints the entire `amountToMint`
 *      supply to the publisher's jetton wallet.
 *
 * The master address is deterministic (`contractAddress(0, {code, data})`),
 * so re-signing with the same `userWalletAddress` + metadata yields the
 * same address — re-deploys are idempotent.
 */
export function buildDeployAndMintMessage(params: BuildDeployAndMintParams): BuildDeployAndMintResult {
  const userAddr = Address.parse(params.userWalletAddress);

  if (!params.metadata?.name || !params.metadata?.symbol) {
    throw new Error("Jetton metadata requires both `name` and `symbol`");
  }

  const content = buildJettonOnchainMetadataCell({
    decimals: "9",          // TIP-64 default; callers may override via metadata.decimals
    ...params.metadata,
  });
  const data = jettonInitData(userAddr, content);
  const code = jettonMinterCode();

  const stateInitCell = beginCell()
    .store(storeStateInit({ code, data }))
    .endCell();

  const masterAddr = contractAddress(0, { code, data });

  const mintBody = jettonMintBody({
    owner: userAddr,
    jettonValue: params.amountToMint,
    forwardToJWallet: JETTON_FORWARD_TO_USER_WALLET,
    queryId: params.queryId,
  });

  const validUntil = Math.floor(Date.now() / 1000) + 600;
  const amount = (params.attachedTonNano ?? JETTON_DEPLOY_GAS_NANO).toString();

  return {
    jettonMasterAddress: masterAddr.toString({ bounceable: true, urlSafe: true }),
    message: {
      address: masterAddr.toString({ bounceable: true, urlSafe: true }),
      amount,
      stateInit: stateInitCell.toBoc().toString("base64"),
      payload: mintBody.toBoc().toString("base64"),
    },
    validUntil,
  };
}

// ── Jetton wallet derivation ─────────────────────────────────────────────────

/**
 * Derive the deterministic Jetton wallet address for `(jettonMaster, owner)`.
 * Mirrors the on-chain `data` layout enforced by the audited wallet contract:
 *   { balance: Coins, owner: Address, master: Address, code: ^Cell }
 */
export function deriveJettonWalletAddress(opts: {
  jettonMasterAddress: string;
  ownerAddress: string;
}): { address: string; simulated: boolean } {
  const code = jettonWalletCode();
  const master = Address.parse(opts.jettonMasterAddress);
  const owner = Address.parse(opts.ownerAddress);

  const data = beginCell()
    .storeCoins(0)
    .storeAddress(owner)
    .storeAddress(master)
    .storeRef(code)
    .endCell();
  const addr = contractAddress(0, { code, data });
  return { address: addr.toString({ bounceable: true, urlSafe: true }), simulated: false };
}

// ── Jetton transfer message (user → user's jWallet → destination) ───────────

export function buildJettonTransferMessage(opts: {
  userJettonWalletAddress: string;
  destinationOwnerAddress: string;
  amountAtomic: bigint;
  textComment: string;
  attachedTon?: string;
  forwardTon?: string;
}): TonConnectMessage {
  const dest = Address.parse(opts.destinationOwnerAddress);
  const forwardPayload = textCommentCell(opts.textComment);

  const transferBody = beginCell()
    .storeUint(OP_TRANSFER, 32)
    .storeUint(BigInt(Date.now()) & ((1n << 64n) - 1n), 64)
    .storeCoins(opts.amountAtomic)
    .storeAddress(dest)
    .storeAddress(dest)
    .storeBit(false)
    .storeCoins(toNano(opts.forwardTon || "0.05"))
    .storeBit(true).storeRef(forwardPayload)
    .endCell();

  return {
    address: opts.userJettonWalletAddress,
    amount: toNano(opts.attachedTon || "0.1").toString(),
    payload: transferBody.toBoc().toString("base64"),
  };
}

// ── Plain TON transfer (with text comment) ──────────────────────────────────

export function buildTonTransferMessage(opts: {
  to: string;
  tonAmount: string;
  textComment?: string;
}): TonConnectMessage {
  const payload = opts.textComment
    ? textCommentCell(opts.textComment).toBoc().toString("base64")
    : undefined;
  return {
    address: opts.to,
    amount: toNano(opts.tonAmount).toString(),
    payload,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert TON whole-units to nanoTON BigInt. */
export function tonToNano(ton: number | string): bigint {
  return toNano(String(ton));
}

/** Address of the platform vault (collects fees + holds LP). */
export function platformVaultAddress(): string {
  return BillingService.TON_WALLET;
}

/** Public-facing config bundle for the publish flow. */
export function publishConfigSnapshot() {
  const cfg = runtimeConfig.get().appStore;
  return {
    publishFeeTon: cfg.publishFeeTon,
    initialLiquidityTon: cfg.initialLiquidityTon,
    initialLiquidityTokenShare: cfg.initialLiquidityTokenShare,
    minInitialLiquidityTon: cfg.minInitialLiquidityTon,
    minInitialLiquidityTokenShare: cfg.minInitialLiquidityTokenShare,
    tokenTotalSupply: cfg.tokenTotalSupply,
    vaultAddress: platformVaultAddress(),
    infraReady: isJettonInfraReady(),
    // Token contract presets — surfaced to the UI so the publish form can
    // render an explicit "this is what you'll see in your wallet" preview.
    // These values mirror the minter.ton.org defaults so wallets show the
    // same fields users are already familiar with.
    tokenPreset: {
      decimals: 9,
      defaultSupply: cfg.tokenTotalSupply,
      defaultDescription: "",
      mintMode: "single_mint",            // total supply minted on deploy
      adminAddress: "deployer_wallet",    // publisher becomes the on-chain admin
      contractRepo: MINTER_CONTRACT_REPO_URL,
      contractTemplate: "ton-blockchain/minter-contract (TIP-3 standard)",
      // Gas the wallet will quote (matches minter.ton.org).
      deployGasTon: "0.25",
      // On-chain metadata (no external HTTPS dependency).
      metadataMode: "onchain",
    },
  };
}
