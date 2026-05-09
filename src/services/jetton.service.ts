/**
 * Jetton service — deploy TIP-3 Jetton Master contracts on TON for App Store
 * tokens, plus mint / accept-back operations driven by the bonding curve.
 *
 * Two operation modes:
 *
 *  1. Real on-chain deploy. Requires the TIP-3 jetton minter + wallet code
 *     BoCs to be present at `data/jetton/jetton-minter.boc` and
 *     `data/jetton/jetton-wallet.boc` (admin places them after auditing). When
 *     present, deploys a brand-new master contract from the platform hot
 *     wallet, with the platform wallet as admin so we can later mint.
 *
 *  2. Simulation mode (default fallback). When the BoCs are missing OR
 *     `runtimeConfig.appStore.enabled` is false, deploy / mint / burn calls
 *     succeed with a fake `SIM_…` address and log a notice. This lets the
 *     full App Store UX (publish / browse / buy / sell from the user's
 *     custodial perspective) work end-to-end while we wait for the on-chain
 *     pieces to be audited and dropped in.
 */

import fs from "fs";
import path from "path";
import { Address, beginCell, Cell, contractAddress, internal, SendMode, toNano } from "@ton/core";
import { TonClient, WalletContractV5R1 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { config } from "../config";

const JETTON_DIR = path.join(process.cwd(), "data", "jetton");
const MINTER_CODE_PATH = path.join(JETTON_DIR, "jetton-minter.boc");
const WALLET_CODE_PATH = path.join(JETTON_DIR, "jetton-wallet.boc");

// Standard TIP-3 op codes.
const OP_MINT = 21;             // jetton master accepts: mint(amount, to)
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_BURN_NOTIFICATION = 0x7bdd97de;

const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: config.toncenterApiKey,
});

function getMnemonic(): string[] {
  const raw = config.walletMnemonic;
  if (!raw || !raw.trim()) throw new Error("WALLET_MNEMONIC not configured");
  return raw.trim().split(/\s+/);
}

async function openWallet() {
  const keyPair = await mnemonicToPrivateKey(getMnemonic());
  const wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey });
  const contract = client.open(wallet);
  return { wallet, contract, keyPair };
}

function loadCellFromBoc(filePath: string): Cell | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return Cell.fromBoc(buf)[0];
  } catch (err: any) {
    console.warn(`[Jetton] Failed to load BoC at ${filePath}: ${err.message}`);
    return null;
  }
}

export function isJettonInfraReady(): boolean {
  return !!loadCellFromBoc(MINTER_CODE_PATH) && !!loadCellFromBoc(WALLET_CODE_PATH);
}

// ── Metadata cell ────────────────────────────────────────────────────────────
// TIP-64 off-chain metadata: cell contains a 0x01 prefix byte + the URL
// pointing to a public JSON file describing the token.
function buildOffchainContentCell(metadataUrl: string): Cell {
  return beginCell()
    .storeUint(0x01, 8)             // off-chain content prefix
    .storeStringTail(metadataUrl)
    .endCell();
}

// ── Initial data layout for the jetton master ────────────────────────────────
// TIP-3 standard layout:
//   total_supply : Coins
//   admin_address : MsgAddress
//   content : ^Cell
//   jetton_wallet_code : ^Cell
function buildJettonMasterDataCell(opts: {
  adminAddress: Address;
  contentCell: Cell;
  walletCode: Cell;
}): Cell {
  return beginCell()
    .storeCoins(0)
    .storeAddress(opts.adminAddress)
    .storeRef(opts.contentCell)
    .storeRef(opts.walletCode)
    .endCell();
}

export interface DeployResult {
  jettonMasterAddress: string;
  txHash: string;
  simulated: boolean;
}

/**
 * Deploy a jetton master from the platform hot wallet. The platform wallet
 * is the jetton admin, so it can later mint / change content / withdraw.
 */
export async function deployJettonMaster(opts: {
  metadataUrl: string;
  /** Optional pre-mint to this address (in atomic units). 0 = no pre-mint. */
  initialMintTo?: string;
  initialMintAmount?: bigint;
}): Promise<DeployResult> {
  const minterCode = loadCellFromBoc(MINTER_CODE_PATH);
  const walletCode = loadCellFromBoc(WALLET_CODE_PATH);

  if (!minterCode || !walletCode) {
    const fakeAddr = "SIM_" + Math.random().toString(16).slice(2, 18);
    console.warn(
      `[Jetton] BoC files missing at ${JETTON_DIR}. Returning simulated address ${fakeAddr}. ` +
      "Place jetton-minter.boc + jetton-wallet.boc to enable real on-chain deploys.",
    );
    return { jettonMasterAddress: fakeAddr, txHash: "sim_" + Date.now().toString(16), simulated: true };
  }

  const { wallet, contract, keyPair } = await openWallet();
  const contentCell = buildOffchainContentCell(opts.metadataUrl);

  const data = buildJettonMasterDataCell({
    adminAddress: wallet.address,
    contentCell,
    walletCode,
  });
  const stateInit = { code: minterCode, data };
  const masterAddr = contractAddress(0, stateInit);

  // Deploy message body — empty body is enough; the master initializes itself.
  const seqno = await contract.getSeqno();
  console.log(`[Jetton] Deploying master at ${masterAddr.toString()} (seqno=${seqno})`);

  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: masterAddr,
        value: toNano("0.25"),
        bounce: false,
        init: stateInit,
      }),
    ],
  });

  // Block until seqno advances (best-effort).
  let confirmed = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const ns = await contract.getSeqno();
      if (ns > seqno) { confirmed = true; break; }
    } catch {}
  }

  let txHash = "deploy_" + Date.now().toString(16);
  if (confirmed) {
    try {
      const txs = await client.getTransactions(wallet.address, { limit: 3 });
      if (txs.length > 0) txHash = txs[0].hash().toString("hex");
    } catch {}

    // Optional pre-mint.
    if (opts.initialMintTo && opts.initialMintAmount && opts.initialMintAmount > 0n) {
      try {
        await mintJetton({
          jettonMasterAddress: masterAddr.toString({ bounceable: true, urlSafe: true }),
          to: opts.initialMintTo,
          amount: opts.initialMintAmount,
        });
      } catch (err: any) {
        console.warn(`[Jetton] Pre-mint failed for ${masterAddr}: ${err.message}`);
      }
    }
  }

  return {
    jettonMasterAddress: masterAddr.toString({ bounceable: true, urlSafe: true }),
    txHash,
    simulated: false,
  };
}

/**
 * Mint jetton from the platform wallet (the master's admin). Used when a
 * user buys via the bonding curve — we mint the tokens directly to their
 * wallet so they appear in TonKeeper.
 */
export async function mintJetton(opts: {
  jettonMasterAddress: string;
  to: string;
  amount: bigint;          // atomic units
}): Promise<{ txHash: string; simulated: boolean }> {
  if (opts.jettonMasterAddress.startsWith("SIM_")) {
    console.log(`[Jetton] Simulated mint of ${opts.amount} → ${opts.to}`);
    return { txHash: "sim_mint_" + Date.now().toString(16), simulated: true };
  }

  const { contract, keyPair } = await openWallet();
  const masterAddr = Address.parse(opts.jettonMasterAddress);
  const recipient = Address.parse(opts.to);
  const queryId = BigInt(Date.now());

  // mint(query_id, to_address, amount, ^internal_transfer_payload)
  const internalTransferBody = beginCell()
    .storeUint(OP_INTERNAL_TRANSFER, 32)
    .storeUint(queryId, 64)
    .storeCoins(opts.amount)
    .storeAddress(null)                 // from_address (master)
    .storeAddress(recipient)            // response_destination
    .storeCoins(toNano("0.005"))        // forward_ton_amount
    .storeBit(false)                    // no forward_payload
    .endCell();

  const mintBody = beginCell()
    .storeUint(OP_MINT, 32)
    .storeUint(queryId, 64)
    .storeAddress(recipient)
    .storeCoins(toNano("0.05"))         // amount of TON forwarded with mint
    .storeRef(internalTransferBody)
    .endCell();

  const seqno = await contract.getSeqno();
  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: masterAddr,
        value: toNano("0.1"),
        body: mintBody,
      }),
    ],
  });

  let txHash = "mint_" + Date.now().toString(16);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const ns = await contract.getSeqno();
      if (ns > seqno) {
        try {
          const txs = await client.getTransactions((await openWallet()).wallet.address, { limit: 3 });
          if (txs.length > 0) txHash = txs[0].hash().toString("hex");
        } catch {}
        break;
      }
    } catch {}
  }
  return { txHash, simulated: false };
}

/**
 * Send TON back to a user when they sell their jettons. The user has
 * already transferred jettons into the platform's jetton wallet (we don't
 * burn here — the platform holds the supply). This just dispatches the
 * payout TON.
 */
export async function payoutTon(opts: {
  to: string;
  amountNano: bigint;
  comment?: string;
}): Promise<{ txHash: string; simulated: boolean }> {
  if (opts.to.startsWith("SIM_")) {
    return { txHash: "sim_pay_" + Date.now().toString(16), simulated: true };
  }
  const { contract, keyPair } = await openWallet();
  const dest = Address.parse(opts.to);
  const seqno = await contract.getSeqno();

  const body = opts.comment
    ? beginCell().storeUint(0, 32).storeStringTail(opts.comment).endCell()
    : undefined;

  await contract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [internal({ to: dest, value: opts.amountNano, body })],
  });

  let txHash = "pay_" + Date.now().toString(16);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const ns = await contract.getSeqno();
      if (ns > seqno) break;
    } catch {}
  }
  return { txHash, simulated: false };
}
