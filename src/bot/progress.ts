import { EMOJI, ce } from "./emoji";
import { Lang, t } from "./i18n";

function progressBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round(clamped / 10);

  const start = filled >= 1
    ? ce(EMOJI.progress_start_full)
    : ce(EMOJI.progress_start_empty);

  let middle = "";
  for (let i = 2; i <= 9; i++) {
    middle += i <= filled
      ? ce(EMOJI.progress_full)
      : ce(EMOJI.progress_empty);
  }

  const end = filled >= 10
    ? ce(EMOJI.progress_end_full)
    : ce(EMOJI.progress_end_empty);

  return `${start}${middle}${end}`;
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

export function processMessage(status: string, percent?: number, lang: Lang = "en"): string {
  const bar = typeof percent === "number" ? `\n${t(lang, "progress_label")} <b>${Math.max(0, Math.min(100, percent))}%</b>\n${progressBar(percent)}` : "";
  return `<b>${ce(EMOJI.loading, "⏳")} ${t(lang, "process_going")}</b>${bar}\n<blockquote>${status}</blockquote>`;
}

export function doneMessage(title: string, detail: string): string {
  return `<b>${ce(EMOJI.indicator_success, "✅")} ${title}</b>\n${detail}`;
}

export function errorMessage(detail: string, lang: Lang = "en"): string {
  return `<b>${ce(EMOJI.indicator_error, "❌")} ${t(lang, "something_wrong")}</b>\n${detail}`;
}

export function costLine(costUsd: number, newBalance: number, lang: Lang = "en"): string {
  return `<blockquote>${ce(EMOJI.dollar, "💲")} ${t(lang, "cost_label")} <b>$${costUsd.toFixed(4)}</b> | ${t(lang, "balance_label")} <b>$${newBalance.toFixed(2)}</b></blockquote>`;
}

export function truncSummary(text: string, maxLen = 2000, lang: Lang = "en"): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + `\n…<i>${t(lang, "truncated")}</i>`;
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function checklistMessage(title: string, items: ChecklistItem[], status?: string, lang: Lang = "en"): string {
  const lines = items.map(item => {
    const emoji = item.done
      ? ce(EMOJI.mark_done, "✅")
      : ce(EMOJI.mark_empty, "⬜");
    return `${emoji} ${esc(item.text)}`;
  });
  const doneCount = items.filter(i => i.done).length;
  const percent = Math.round((doneCount / items.length) * 100);
  const bar = `${t(lang, "progress_label")} <b>${Math.max(0, Math.min(100, percent))}%</b>\n${progressBar(percent)}`;
  const statusLine = status ? `\n<blockquote>${status}</blockquote>` : "";
  return `<b>${ce(EMOJI.loading, "⏳")} ${title}</b>\n\n${lines.join("\n")}\n\n${bar}${statusLine}`;
}
