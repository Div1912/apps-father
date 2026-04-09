// Sections to hide from the user — technical detail only Claude needs
const TECHNICAL_SECTIONS = [
  "technical requirements",
  "api endpoints",
  "api routes",
  "api endpoints needed",
  "database schema",
  "database tables",
  "backend routes",
  "implementation details",
  "animation details",
  "technical notes",
  "technical specs",
  "technical specification",
  "development notes",
  "user management",
  "weather data",
  "search history",
  "favorites",
  "utility",
  "city search",
];

function isTechnicalSection(heading: string): boolean {
  const lower = heading.toLowerCase();
  return TECHNICAL_SECTIONS.some((s) => lower.includes(s));
}

/**
 * Converts a raw markdown plan into HTML safe for Telegram,
 * stripping technical sections the user doesn't need to see.
 */
export function formatPlanForUser(raw: string): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let skipSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headings (## or ###)
    const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/);
    if (headingMatch) {
      const heading = headingMatch[1];
      if (isTechnicalSection(heading)) {
        skipSection = true;
        continue;
      }
      skipSection = false;
      out.push(`\n<b>${escHtml(heading)}</b>`);
      continue;
    }

    if (skipSection) continue;

    // Bold: **text** or __text__
    let processed = trimmed
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/__(.+?)__/g, "<b>$1</b>")
      // Italic: *text* or _text_ (avoid single * used as bullet)
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>")
      // Inline code
      .replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bullet points
    if (/^[-*+]\s/.test(trimmed)) {
      processed = "• " + processed.replace(/^[-*+]\s+/, "").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
      out.push(processed);
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(trimmed)) {
      out.push(processed);
      continue;
    }

    // Empty line — keep spacing
    if (trimmed === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }

    out.push(escHtml(processed));
  }

  // Collapse multiple blank lines into one
  const collapsed = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // Hard limit to stay within Telegram's 4096 char message limit
  // (leaves ~500 chars for the header, cost line, and keyboard markup)
  const MAX_PLAN_LEN = 3000;
  if (collapsed.length > MAX_PLAN_LEN) {
    return collapsed.substring(0, MAX_PLAN_LEN) + "\n…<i>(plan truncated for display)</i>";
  }
  return collapsed;
}

function escHtml(text: string): string {
  // Only escape raw characters not already inside HTML tags we inserted
  return text
    .replace(/&(?![a-zA-Z]+;|#\d+;)/g, "&amp;")
    .replace(/<(?!\/?(?:b|i|code|blockquote)>)/g, "&lt;");
}
