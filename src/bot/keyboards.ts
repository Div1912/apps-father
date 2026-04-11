import { EMOJI } from "./emoji";
import { PAID_FEATURES } from "../services/features.service";
import { config } from "../config";
import { Lang, t, LANG_NAMES, translateFeatureLabel } from "./i18n";

export function createAppKeyboard(lang: Lang = "en", miniAppUrl: string) {
  return {
    text: `${t(lang, "btn_create_app")}`,
    web_app: { url: miniAppUrl },
  };
}

export function replyKeyboard(lang: Lang = "en") {
  return {
    keyboard: [
      [
        {
          text: t(lang, "main_menu"),
          icon_custom_emoji_id: EMOJI.list
        },
      ],
    ],
    resize_keyboard: true,
  };
}

export function welcomeKeyboard(lang: Lang = "en") {
  return {
    inline_keyboard: [
      [
        { text: t(lang, "btn_create_app"), callback_data: "new_project", icon_custom_emoji_id: EMOJI.add },
        { text: t(lang, "btn_app_list"), callback_data: "my_projects", icon_custom_emoji_id: EMOJI.list },
      ],
      [
        { text: t(lang, "btn_topup"), callback_data: "topup", icon_custom_emoji_id: EMOJI.dollar },
        { text: t(lang, "btn_referral"), callback_data: "referral", icon_custom_emoji_id: EMOJI.idea },
      ],
      [
        { text: t(lang, "btn_language"), callback_data: "language", icon_custom_emoji_id: EMOJI.setting },
        { text: t(lang, "btn_help"), callback_data: "help", icon_custom_emoji_id: EMOJI.help },
      ],
    ],
  };
}

export function languageKeyboard(currentLang: Lang) {
  const langs: Lang[] = ["en", "ru", "ua"];
  const rows: any[][] = langs.map(l => [{
    text: `${l === currentLang ? "✅ " : ""}${LANG_NAMES[l]}`,
    callback_data: `lang:${l}`,
    icon_custom_emoji_id: l === currentLang ? EMOJI.indicator_success : EMOJI.indicator_none,
  }]);
  rows.push([{ text: t(currentLang, "btn_back"), callback_data: "nav_welcome" }]);
  return { inline_keyboard: rows };
}

export function createBotKeyboard(suggestedName?: string) {
  return {
    keyboard: [
      [
        {
          text: "Create App & Bot",
          icon_custom_emoji_id: EMOJI.add,
          request_managed_bot: {
            request_id: 1,
            ...(suggestedName ? { suggested_name: suggestedName } : {}),
          },
        },
      ],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

export function projectListKeyboard(projects: { id: string; name: string; status: string }[], slotsAvailable: boolean = true, lang: Lang = "en") {
  const rows: any[][] = projects.map((p) => [
    { text: p.name, callback_data: `project:${p.id}`, icon_custom_emoji_id: statusEmojiId(p.status) },
  ]);
  if (!slotsAvailable) {
    rows.push([{ text: t(lang, "buy_slot_btn"), callback_data: "buy_slot", icon_custom_emoji_id: EMOJI.add }]);
  }
  rows.push([{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }]);
  return { inline_keyboard: rows };
}

export function projectActionsKeyboard(projectId: string, status: string, features: string[] = [], botUsername?: string, lang: Lang = "en") {
  const rows: any[][] = [];

  if (status === "deployed" || status === "released") {
    const devUrl = `${config.baseUrl}/dev/${projectId}/`;
    rows.push([
      { text: t(lang, "btn_open_app"), web_app: { url: devUrl } },
      { text: t(lang, "btn_release_version"), callback_data: `release:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_success },
    ]);

    rows.push([
      { text: t(lang, "btn_update_app"), callback_data: `update_app:${projectId}`, icon_custom_emoji_id: EMOJI.update },
      { text: t(lang, "btn_versions"), callback_data: `versions:${projectId}`, icon_custom_emoji_id: EMOJI.list },
    ]);

    const extraRow: any[] = [];
    if (features.includes("admin_panel")) {
      extraRow.push({ text: t(lang, "btn_admin_panel"), callback_data: `admin:${projectId}`, icon_custom_emoji_id: EMOJI.setting });
    }
    if (features.includes("get_code")) {
      extraRow.push({ text: t(lang, "btn_edit_code"), callback_data: `edit_code:${projectId}`, icon_custom_emoji_id: EMOJI.setting });
    }
    if (extraRow.length > 0) rows.push(extraRow);

    rows.push([
      { text: t(lang, "btn_suggestions"), callback_data: `suggest:${projectId}`, icon_custom_emoji_id: EMOJI.idea },
    ]);
  } else if (status === "planning" || status === "created") {
    rows.push([
      { text: t(lang, "btn_describe_app"), callback_data: `describe:${projectId}`, icon_custom_emoji_id: EMOJI.idea },
    ]);
  }

  const featuresRow: any[] = [
    { text: t(lang, "btn_features"), callback_data: `features:${projectId}`, icon_custom_emoji_id: EMOJI.dollar },
  ];
  if (features.includes("ton_payment")) {
    featuresRow.push({ text: t(lang, "btn_wallet"), callback_data: `wallet:${projectId}`, icon_custom_emoji_id: EMOJI.dollar });
  }
  rows.push(featuresRow);
  rows.push([
    { text: t(lang, "btn_settings"), callback_data: `settings:${projectId}`, icon_custom_emoji_id: EMOJI.setting },
    { text: t(lang, "btn_back"), callback_data: "nav_list" },
  ]);
  return { inline_keyboard: rows };
}

export function settingsKeyboard(projectId: string, lang: Lang = "en") {
  return {
    inline_keyboard: [
      [
        { text: t(lang, "btn_get_info"), callback_data: `info:${projectId}`, icon_custom_emoji_id: EMOJI.help },
        { text: t(lang, "btn_quality"), callback_data: `quality:${projectId}`, icon_custom_emoji_id: EMOJI.setting },
      ],
      [
        { text: t(lang, "btn_regen_context"), callback_data: `regen_context:${projectId}`, icon_custom_emoji_id: EMOJI.update },
      ],
      [
        { text: t(lang, "btn_transfer"), callback_data: `transfer:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_warning },
      ],
      [
        { text: t(lang, "btn_remove"), callback_data: `remove_project:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_error },
        { text: t(lang, "btn_back"), callback_data: `project:${projectId}` },
      ],
    ],
  };
}

export function qualityKeyboard(projectId: string, currentTier: number, lang: Lang = "en") {
  const tiers = [
    { tier: 1, name: t(lang, "quality_good"), desc: t(lang, "quality_good_desc") },
    { tier: 2, name: t(lang, "quality_better"), desc: t(lang, "quality_better_desc") },
    { tier: 3, name: t(lang, "quality_best"), desc: t(lang, "quality_best_desc") },
    { tier: 4, name: t(lang, "quality_the_best"), desc: t(lang, "quality_the_best_desc") },
  ];
  const rows: any[][] = tiers.map(({ tier, name, desc }) => [{
    text: `${name} — ${desc}`,
    callback_data: `qt:${projectId}:${tier}`,
    icon_custom_emoji_id: tier === currentTier ? EMOJI.indicator_success : EMOJI.indicator_none,
  }]);
  rows.push([{ text: t(lang, "btn_back"), callback_data: `settings:${projectId}` }]);
  return { inline_keyboard: rows };
}

export function featuresKeyboard(projectId: string, unlockedFeatures: string[], lang: Lang = "en") {
  const rows: any[][] = PAID_FEATURES.map(f => {
    const owned = unlockedFeatures.includes(f.id);
    const label = translateFeatureLabel(lang, f.id) || f.label;
    return [{
      text: owned ? `✅ ${label}` : `🔒 ${label} — $${f.price}`,
      callback_data: owned ? `fo:${projectId}:${f.id}` : `bf:${projectId}:${f.id}`,
    }];
  });
  rows.push([{ text: t(lang, "btn_back"), callback_data: `project:${projectId}` }]);
  return { inline_keyboard: rows };
}

export function confirmBuyKeyboard(projectId: string, featureId: string, lang: Lang = "en") {
  return {
    inline_keyboard: [
      [{ text: t(lang, "btn_confirm_purchase"), callback_data: `cb:${projectId}:${featureId}`, icon_custom_emoji_id: EMOJI.indicator_success }],
      [{ text: t(lang, "btn_cancel"), callback_data: `features:${projectId}` }],
    ],
  };
}

export function removeConfirmKeyboard(projectId: string, lang: Lang = "en") {
  return {
    inline_keyboard: [
      [
        { text: t(lang, "btn_yes_delete"), callback_data: `confirm_remove:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_error },
      ],
      [
        { text: t(lang, "btn_cancel"), callback_data: `project:${projectId}` },
      ],
    ],
  };
}

export function planActionKeyboard(projectId: string, lang: Lang = "en") {
  return {
    inline_keyboard: [
      [
        { text: t(lang, "btn_approve_build"), callback_data: `approve_plan:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_success },
      ],
      [
        { text: t(lang, "btn_modify"), callback_data: `modify_plan:${projectId}`, icon_custom_emoji_id: EMOJI.update },
        { text: t(lang, "btn_decline"), callback_data: `decline_plan:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_error },
      ],
    ],
  };
}

export function suggestionsKeyboard(projectId: string, suggestions: string[], lang: Lang = "en") {
  const rows: any[][] = suggestions.map((_, i) => [
    { text: t(lang, "btn_apply", { n: String(i + 1) }), callback_data: `apply_suggestion:${projectId}:${i}`, icon_custom_emoji_id: EMOJI.indicator_success },
  ]);
  rows.push([
    { text: t(lang, "btn_skip_all"), callback_data: `skip_suggestions:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_error },
  ]);
  return { inline_keyboard: rows };
}

export function versionsKeyboard(projectId: string, commits: { version: string; changelog: string | null; createdAt: Date }[], releaseCommit: number | null, lang: Lang = "en") {
  const rows: any[][] = commits.slice(0, 10).map(c => {
    const num = parseInt(c.version, 10);
    const isReleased = releaseCommit !== null && num === releaseCommit;
    const label = `${isReleased ? "✅ " : ""}#${c.version} — ${(c.changelog || "").substring(0, 30)}`;
    return [{ text: label, callback_data: `rv:${projectId}:${c.version}` }];
  });
  rows.push([{ text: t(lang, "btn_back"), callback_data: `project:${projectId}` }]);
  return { inline_keyboard: rows };
}

export function revertConfirmKeyboard(projectId: string, commitNum: string, lang: Lang = "en") {
  return {
    inline_keyboard: [
      [{ text: t(lang, "btn_yes_revert"), callback_data: `rvc:${projectId}:${commitNum}`, icon_custom_emoji_id: EMOJI.indicator_warning }],
      [{ text: t(lang, "btn_cancel"), callback_data: `versions:${projectId}` }],
    ],
  };
}

export function helpKeyboard(lang: Lang = "en") {
  return {
    inline_keyboard: [
      [
        { text: t(lang, "btn_guide"), url: "https://cooperative-postbox-f64.notion.site/Apps-Father-User-Guide-33bb63eb0f25800688fde83c353b5891?source=copy_link" },
        { text: t(lang, "btn_promo"), url: "https://cooperative-postbox-f64.notion.site/Apps-Father-Promo-33bb63eb0f258090bff4e63cffd8e1ae?source=copy_link" },
      ],
      [
        { text: t(lang, "btn_channel"), url: "https://t.me/apps_father" },
        { text: t(lang, "btn_community"), url: "https://t.me/+of-sS1zbZHBmMDJi" },
      ],
      [{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }],
    ],
  };
}

export function backToProjectKeyboard(projectId: string, lang: Lang = "en") {
  return {
    inline_keyboard: [
      [{ text: t(lang, "btn_back"), callback_data: `project:${projectId}` }],
    ],
  };
}

function statusEmojiId(status: string): string {
  switch (status) {
    case "deployed":
    case "released":
      return EMOJI.indicator_success;
    case "building":
    case "planning":
      return EMOJI.indicator_warning;
    case "error":
      return EMOJI.indicator_error;
    default:
      return EMOJI.indicator_none;
  }
}
