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
  mark_empty:        "5386836201271501633",
  mark_done:         "5386312984060534078",
  progress_start_empty: "5386652488340379423",
  progress_empty:       "5386436812262644830",
  progress_end_empty:   "5386828891237158955",
  progress_start_full:  "5386340802563709741",
  progress_full:        "5386681015513157928",
  progress_end_full:    "5386625885312949408",
  loading:              "5309893756244206277",
  crypto_bot:           "5361914370068613491",
  usdt:                 "5406841020769936275",
  stars:                "5406812184359507637",
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
