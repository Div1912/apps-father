import CryptoJS from "crypto-js";
import { config } from "../config";

export function encryptToken(token: string): string {
  return CryptoJS.AES.encrypt(token, config.encryptionKey).toString();
}

export function decryptToken(encrypted: string): string {
  const bytes = CryptoJS.AES.decrypt(encrypted, config.encryptionKey);
  return bytes.toString(CryptoJS.enc.Utf8);
}
