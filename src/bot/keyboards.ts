import { EMOJI } from "./emoji";
import { PAID_FEATURES } from "../services/features.service";
import { config } from "../config";

// Persistent reply keyboard (bottom)
export function replyKeyboard() {
  return {
    keyboard: [
      [
        {
          text: "Main Menu",
          icon_custom_emoji_id: EMOJI.list
        },
      ],
    ],
    resize_keyboard: true,
  };
}

// Inline keyboard for the welcome navigation panel
export function welcomeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Create App", callback_data: "new_project", icon_custom_emoji_id: EMOJI.add },
        { text: "App List", callback_data: "my_projects", icon_custom_emoji_id: EMOJI.list },
      ],
      [
        { text: "Top Up", callback_data: "topup", icon_custom_emoji_id: EMOJI.dollar },
        { text: "Help?", callback_data: "help", icon_custom_emoji_id: EMOJI.help },
      ],
    ],
  };
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

export function projectListKeyboard(projects: { id: string; name: string; status: string }[], slotsAvailable: boolean = true) {
  const rows: any[][] = projects.map((p) => [
    { text: p.name, callback_data: `project:${p.id}`, icon_custom_emoji_id: statusEmojiId(p.status) },
  ]);
  if (!slotsAvailable) {
    rows.push([{ text: "Buy App Slot — $25", callback_data: "buy_slot", icon_custom_emoji_id: EMOJI.add }]);
  }
  rows.push([{ text: "Back", callback_data: "nav_welcome" }]);
  return { inline_keyboard: rows };
}

export function projectActionsKeyboard(projectId: string, status: string, features: string[] = [], botUsername?: string) {
  const rows: any[][] = [];

  if (status === "deployed" || status === "released") {
    const devUrl = `${config.baseUrl}/dev/${projectId}/`;
    rows.push([
      { text: "Open App", web_app: { url: devUrl } },
      { text: "Update App", callback_data: `update_app:${projectId}`, icon_custom_emoji_id: EMOJI.update },
    ]);

    const row2: any[] = [];
    if (features.includes("admin_panel")) {
      row2.push({ text: "Admin Panel", callback_data: `admin:${projectId}`, icon_custom_emoji_id: EMOJI.setting });
    }
    if (features.includes("get_code")) {
      row2.push({ text: "Edit Code", callback_data: `edit_code:${projectId}`, icon_custom_emoji_id: EMOJI.setting });
    }
    if (row2.length > 0) rows.push(row2);

    rows.push([
      { text: "Release Version", callback_data: `release:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_success },
      { text: "Versions", callback_data: `versions:${projectId}`, icon_custom_emoji_id: EMOJI.list },
    ]);

    rows.push([
      { text: "Suggestions", callback_data: `suggest:${projectId}`, icon_custom_emoji_id: EMOJI.idea },
    ]);
  } else if (status === "planning" || status === "created") {
    rows.push([
      { text: "Describe Your App", callback_data: `describe:${projectId}`, icon_custom_emoji_id: EMOJI.idea },
    ]);
  }

  const featuresRow: any[] = [
    { text: "Features", callback_data: `features:${projectId}`, icon_custom_emoji_id: EMOJI.dollar },
  ];
  if (features.includes("ton_payment")) {
    featuresRow.push({ text: "Wallet", callback_data: `wallet:${projectId}`, icon_custom_emoji_id: EMOJI.dollar });
  }
  rows.push(featuresRow);
  rows.push([
    { text: "Settings", callback_data: `settings:${projectId}`, icon_custom_emoji_id: EMOJI.setting },
    { text: "Back", callback_data: "nav_list" },
  ]);
  return { inline_keyboard: rows };
}

export function settingsKeyboard(projectId: string) {
  return {
    inline_keyboard: [
      [
        { text: "Get Info", callback_data: `info:${projectId}`, icon_custom_emoji_id: EMOJI.help },
        { text: "Quality", callback_data: `quality:${projectId}`, icon_custom_emoji_id: EMOJI.setting },
      ],
      [
        { text: "Transfer Ownership", callback_data: `transfer:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_warning },
      ],
      [
        { text: "Remove", callback_data: `remove_project:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_error },
        { text: "Back", callback_data: `project:${projectId}` },
      ],
    ],
  };
}

const QUALITY_LABELS: Record<number, { name: string; desc: string }> = {
  1: { name: "Good (Sonnet)", desc: "Regular pricing" },
  2: { name: "Best (Opus)", desc: "+~75% pricing" },
  3: { name: "The Best (Opus+)", desc: "+~100% pricing" },
};

export function qualityKeyboard(projectId: string, currentTier: number) {
  const rows: any[][] = [1, 2, 3].map(tier => [{
    text: `${tier === currentTier ? "✅" : "⬜"} ${QUALITY_LABELS[tier].name} — ${QUALITY_LABELS[tier].desc}`,
    callback_data: `qt:${projectId}:${tier}`,
  }]);
  rows.push([{ text: "Back", callback_data: `settings:${projectId}` }]);
  return { inline_keyboard: rows };
}

export function featuresKeyboard(projectId: string, unlockedFeatures: string[]) {
  const rows: any[][] = PAID_FEATURES.map(f => {
    const owned = unlockedFeatures.includes(f.id);
    return [{
      text: owned ? `✅ ${f.label}` : `🔒 ${f.label} — $${f.price}`,
      callback_data: owned ? `fo:${projectId}:${f.id}` : `bf:${projectId}:${f.id}`,
    }];
  });
  rows.push([{ text: "Back", callback_data: `project:${projectId}` }]);
  return { inline_keyboard: rows };
}

export function confirmBuyKeyboard(projectId: string, featureId: string) {
  return {
    inline_keyboard: [
      [{ text: "Confirm Purchase", callback_data: `cb:${projectId}:${featureId}`, icon_custom_emoji_id: EMOJI.indicator_success }],
      [{ text: "Cancel", callback_data: `features:${projectId}` }],
    ],
  };
}

export function removeConfirmKeyboard(projectId: string) {
  return {
    inline_keyboard: [
      [
        { text: "Yes, delete everything", callback_data: `confirm_remove:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_error },
      ],
      [
        { text: "Cancel", callback_data: `project:${projectId}` },
      ],
    ],
  };
}

export function planActionKeyboard(projectId: string) {
  return {
    inline_keyboard: [
      [
        { text: "Approve & Build", callback_data: `approve_plan:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_success },
      ],
      [
        { text: "Modify", callback_data: `modify_plan:${projectId}`, icon_custom_emoji_id: EMOJI.update },
        { text: "Decline", callback_data: `decline_plan:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_error },
      ],
    ],
  };
}

export function suggestionsKeyboard(projectId: string, suggestions: string[]) {
  const rows: any[][] = suggestions.map((_, i) => [
    { text: `Apply #${i + 1}`, callback_data: `apply_suggestion:${projectId}:${i}`, icon_custom_emoji_id: EMOJI.indicator_success },
  ]);
  rows.push([
    { text: "Skip All", callback_data: `skip_suggestions:${projectId}`, icon_custom_emoji_id: EMOJI.indicator_error },
  ]);
  return { inline_keyboard: rows };
}

export function versionsKeyboard(projectId: string, commits: { version: string; changelog: string | null; createdAt: Date }[], releaseCommit: number | null) {
  const rows: any[][] = commits.slice(0, 10).map(c => {
    const num = parseInt(c.version, 10);
    const isReleased = releaseCommit !== null && num === releaseCommit;
    const label = `${isReleased ? "✅ " : ""}#${c.version} — ${(c.changelog || "").substring(0, 30)}`;
    return [{ text: label, callback_data: `rv:${projectId}:${c.version}` }];
  });
  rows.push([{ text: "Back", callback_data: `project:${projectId}` }]);
  return { inline_keyboard: rows };
}

export function revertConfirmKeyboard(projectId: string, commitNum: string) {
  return {
    inline_keyboard: [
      [{ text: "Yes, revert", callback_data: `rvc:${projectId}:${commitNum}`, icon_custom_emoji_id: EMOJI.indicator_warning }],
      [{ text: "Cancel", callback_data: `versions:${projectId}` }],
    ],
  };
}

export function helpKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Guide", url: "https://cooperative-postbox-f64.notion.site/Apps-Father-User-Guide-33bb63eb0f25800688fde83c353b5891?source=copy_link" },
        { text: "Promo", url: "https://cooperative-postbox-f64.notion.site/Apps-Father-Promo-33bb63eb0f258090bff4e63cffd8e1ae?source=copy_link" },
      ],
      [
        { text: "Channel", url: "https://t.me/apps_father" },
        { text: "Community", url: "https://t.me/+of-sS1zbZHBmMDJi" },
      ],
      [{ text: "Back", callback_data: "nav_welcome" }],
    ],
  };
}

export function backToProjectKeyboard(projectId: string) {
  return {
    inline_keyboard: [
      [{ text: "Back", callback_data: `project:${projectId}` }],
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
