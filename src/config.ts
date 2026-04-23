import dotenv from "dotenv";
dotenv.config();

export const config = {
  botToken: process.env.APPS_FATHER_TOKEN!,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
  databaseUrl: process.env.DATABASE_URL!,
  domain: process.env.DOMAIN || "localhost",
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  webhookSecret: process.env.WEBHOOK_SECRET || "default-secret",
  encryptionKey: process.env.ENCRYPTION_KEY!,
  nowpaymentsApiKey: process.env.NOWPAYMENTS_API_KEY || "",
  nowpaymentsIpnSecret: process.env.NOWPAYMENTS_IPN_SECRET || "",
  adminPassword: process.env.ADMIN_PASSWORD || "admin",
  cryptoBotToken: process.env.CRYPTO_BOT_TOKEN || "",
  walletMnemonic: process.env.WALLET_MNEMONIC || "",
  toncenterApiKey: process.env.TONCENTER_API_KEY || "",
  withdrawGroupId: process.env.WITHDRAW_GROUP_ID || "-1003984965330",
  openPanelClientId: process.env.OPENPANEL_CLIENT_ID || "",
  openPanelClientSecret: process.env.OPENPANEL_CLIENT_SECRET || "",
  // Same key for dev and prod (provided by product). Override via env if needed.
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "sk_d8d1894ac4e643e5c4aa20e97649837f96d62408da2e96e2",
  // ApiPass — used for nano-banana image generation (AI avatar feature).
  apiPassKey: process.env.APIPASS_KEY || "apk_47d643e413f208561ea96fca31692455e1b6745c1ccab4ce9873ca8cd67250bf",

  get baseUrl(): string {
    if (this.nodeEnv === "development") {
      return `http://localhost:${this.port}`;
    }
    return `https://${this.domain}`;
  },

  get webhookUrl(): string {
    return `${this.baseUrl}/webhook`;
  },
};
