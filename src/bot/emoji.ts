export const EMOJI = {
  logo:              "5377800565038291987",
  add:               "5377849514780565387",
  list:              "5377847332937176471",
  help:              "5375600227522747250",
  idea:              "5375431280689195655",
  indicator_none:    "5377349430263454459",
  indicator_warning: "5377739043926742111",
  indicator_error:   "5377728267853796087",
  indicator_success: "5377544696656599429",
  update:            "5377794122587351169",
  setting:           "5377796922906024957",
  dollar:            "5377851954321989517",
} as const;

export function ce(id: string, fallback = "👍"): string {
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}

export function statusIndicator(status: string): string {
  switch (status) {
    case "deployed":
    case "released":
      return ce(EMOJI.indicator_success, "✅");
    case "building":
    case "planning":
      return ce(EMOJI.indicator_warning, "⏳");
    case "error":
      return ce(EMOJI.indicator_error, "❌");
    default:
      return ce(EMOJI.indicator_none, "⚪");
  }
}
