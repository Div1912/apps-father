import { config } from "../config";
import { TonClient, WalletContractV5R1, JettonMaster } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { Address, beginCell, internal, toNano, SendMode } from "@ton/core";

const USDT_MASTER = Address.parse("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs");
const USDT_DECIMALS = 6;
const JETTON_TRANSFER_OP = 0xf8a7ea5;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getMnemonic(): string[] {
  const raw = config.walletMnemonic;
  if (!raw || !raw.trim()) throw new Error("WALLET_MNEMONIC not configured");
  return raw.trim().split(/\s+/);
}

const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: config.toncenterApiKey,
});

function is429(err: any): boolean {
  const msg = (err?.message || "").toLowerCase();
  return msg.includes("429") || msg.includes("too many") || msg.includes("rate limit");
}

async function retry<T>(fn: () => Promise<T>, label: string, maxRetries = 6): Promise<T> {
  let last: any;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      last = err;
      if (is429(err)) {
        const wait = i === 1 ? 15000 : 10000;
        console.warn(`[Wallet] 429 (${label}) attempt ${i}/${maxRetries}, retry in ${wait / 1000}s`);
        await delay(wait);
      } else throw err;
    }
  }
  throw last;
}

async function getKeyPair() {
  return mnemonicToPrivateKey(getMnemonic());
}

async function openWallet() {
  const keyPair = await getKeyPair();
  const wallet = WalletContractV5R1.create({ publicKey: keyPair.publicKey });
  const contract = client.open(wallet);
  return { wallet, contract, keyPair };
}

export async function getWalletAddress(): Promise<string> {
  const { wallet } = await openWallet();
  return wallet.address.toString({ bounceable: false, urlSafe: true });
}

export async function getWalletBalance(): Promise<number> {
  return retry(async () => {
    const { contract } = await openWallet();
    const bal = await contract.getBalance();
    return Number(bal) / 1e9;
  }, "getBalance");
}

export async function getUsdtBalance(): Promise<number> {
  return retry(async () => {
    const { wallet } = await openWallet();
    const jettonMaster = client.open(JettonMaster.create(USDT_MASTER));
    const jettonWalletAddr = await jettonMaster.getWalletAddress(wallet.address);
    try {
      const result = await client.runMethod(jettonWalletAddr, "get_wallet_data");
      const balance = result.stack.readBigNumber();
      return Number(balance) / 10 ** USDT_DECIMALS;
    } catch {
      return 0;
    }
  }, "getUsdtBalance");
}

/**
 * Send USDT (jetton on TON) from hot wallet to a recipient.
 * @param toAddress  Recipient TON address
 * @param amountUsdt Amount in USDT (e.g. 50.00)
 * @returns Transaction hash or fallback identifier
 */
export async function sendUsdt(toAddress: string, amountUsdt: number): Promise<string> {
  if (!isFinite(amountUsdt) || amountUsdt <= 0) throw new Error(`Invalid USDT amount: ${amountUsdt}`);

  const { wallet, contract, keyPair } = await openWallet();
  const dest = Address.parse(toAddress);

  const jettonMaster = client.open(JettonMaster.create(USDT_MASTER));
  const jettonWalletAddr = await retry(
    () => jettonMaster.getWalletAddress(wallet.address),
    "getJettonWallet",
  );

  const jettonAmount = BigInt(Math.round(amountUsdt * 10 ** USDT_DECIMALS));
  const queryId = BigInt(Date.now());

  const transferBody = beginCell()
    .storeUint(JETTON_TRANSFER_OP, 32)
    .storeUint(queryId, 64)
    .storeCoins(jettonAmount)
    .storeAddress(dest)
    .storeAddress(wallet.address) // response_destination
    .storeBit(false) // no custom_payload
    .storeCoins(toNano("0.01")) // forward_ton_amount
    .storeBit(false) // no forward_payload
    .endCell();

  const seqno = await retry(() => contract.getSeqno(), "getSeqno");
  console.log(`[Wallet] seqno=${seqno}, sending ${amountUsdt} USDT to ${toAddress}`);

  try {
    await contract.sendTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
      messages: [
        internal({
          to: jettonWalletAddr,
          value: toNano("0.065"),
          body: transferBody,
        }),
      ],
    });
  } catch (err: any) {
    console.error("[Wallet] Failed to broadcast USDT transfer:", err.message);
    return "send_failed_" + Date.now().toString(16);
  }

  // Poll for seqno change to confirm
  let confirmed = false;
  let retries = 20;
  let waitMs = 15000;

  while (retries > 0) {
    await delay(waitMs);
    waitMs = 10000;
    try {
      const newSeqno = await contract.getSeqno();
      if (newSeqno > seqno) {
        confirmed = true;
        break;
      }
      retries--;
      console.log(`[Wallet] Seqno unchanged (${newSeqno}), ${retries} retries left`);
    } catch (err: any) {
      retries--;
      console.error(`[Wallet] Poll error (${retries} left):`, err.message);
    }
  }

  // Try to get the latest transaction hash
  let txHash = "";
  if (confirmed) {
    try {
      const txs = await client.getTransactions(wallet.address, { limit: 3 });
      if (txs.length > 0) {
        txHash = txs[0].hash().toString("hex");
      }
    } catch {}
  }

  if (confirmed) {
    const hash = txHash || "confirmed_" + Date.now().toString(16);
    console.log(`[Wallet] Confirmed! ${amountUsdt} USDT → ${toAddress} | hash: ${hash}`);
    return hash;
  }

  const fallback = "sent_" + Date.now().toString(16);
  console.warn(`[Wallet] TX broadcast but not confirmed in polling window. Fallback: ${fallback}`);
  return fallback;
}
