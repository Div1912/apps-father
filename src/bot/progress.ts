import { EMOJI, ce } from "./emoji";

function progressBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round(clamped / 10);
  const empty = 10 - filled;
  return "▓".repeat(filled) + "░".repeat(empty) + ` ${clamped}%`;
}

export function mdToTgHtml(md: string): string {
  let s = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const codeBlocks: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  s = s.replace(/^### (.+)$/gm, "<b>$1</b>");
  s = s.replace(/^## (.+)$/gm, "<b>$1</b>");
  s = s.replace(/^# (.+)$/gm, "<b>$1</b>");
  s = s.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/(?<!\w)__(.+?)__(?!\w)/g, "<b>$1</b>");
  s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
  s = s.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");

  s = s.replace(/\x00CB(\d+)\x00/g, (_m, idx) => `<code>${codeBlocks[Number(idx)]}</code>`);

  s = s.replace(/^[-*] /gm, "• ");
  s = s.replace(/^\d+\.\s/gm, (m) => m);
  return s;
}

export function processMessage(status: string, percent?: number): string {
  const bar = typeof percent === "number" ? `\nProgress: ${progressBar(percent)}` : "";
  return `<b>${ce(EMOJI.indicator_warning, "⏳")} Process is going</b>${bar}\n<blockquote>${status}</blockquote>`;
}

export function doneMessage(title: string, detail: string): string {
  return `<b>${ce(EMOJI.indicator_success, "✅")} ${title}</b>\n${detail}`;
}

export function errorMessage(detail: string): string {
  return `<b>${ce(EMOJI.indicator_error, "❌")} Something went wrong</b>\n${detail}`;
}

export function costLine(costUsd: number, newBalance: number): string {
  return `<blockquote>${ce(EMOJI.dollar, "💲")} Cost: <b>$${costUsd.toFixed(4)}</b> | Balance: <b>$${newBalance.toFixed(2)}</b></blockquote>`;
}

export function truncSummary(text: string, maxLen = 2000): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "\n…<i>(truncated)</i>";
}
