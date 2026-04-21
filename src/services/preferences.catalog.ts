/**
 * Preferences catalog — single source of truth for the visual preferences
 * questionnaire shown after the user's first prompt.
 *
 * - This module owns the *catalog* (categories, options, preview specs, labels).
 * - The actual agent rules for each option live as markdown under
 *   `agent_knowledge/preferences/{category}/{option}.md` so writers can edit
 *   them like any other instruction file. They are loaded lazily and cached.
 *
 * Same definitions are consumed by:
 *   - the mini-app modal (renders `preview` into live cards)
 *   - the planner prompt (`buildPreferencesPrompt`)
 *   - the build agent's `buildApp` user prompt (same builder)
 */

import fs from "fs";
import path from "path";

const PREFERENCES_DIR = path.join(process.cwd(), "agent_knowledge", "preferences");

/**
 * Sentinel value meaning "user delegated this category to the AI".
 * When stored under any preference key the rules markdown is NOT loaded
 * and that whole category is OMITTED from the preferences prompt block,
 * leaving the agent free to make its own judgment for that axis.
 */
export const AUTO_PREFERENCE = "__auto__";

export type PreferenceCategoryId =
  | "style"
  | "theme"
  | "header"
  | "density"
  | "bottomMenu";

export interface StylePreviewSpec {
  kind: "style";
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  primary: string;
  primaryText: string;
  accent: string;
  border: string;
  displayFont: string;
  bodyFont: string;
  radius: number; // px
  shadow: string; // CSS box-shadow
}

export interface ThemePreviewSpec {
  kind: "theme";
  mode: "light" | "dark" | "auto";
}

export interface HeaderPreviewSpec {
  kind: "header";
  layout: "minimal" | "branded" | "large_title";
}

export interface DensityPreviewSpec {
  kind: "density";
  rowHeight: number;
  gap: number;
}

export interface BottomMenuPreviewSpec {
  kind: "bottomMenu";
  layout:
    | "tabbar"
    | "tabbar_pill"
    | "tabbar_glass"
    | "tabbar_fab"
    | "floating_cta"
    | "action_grid"
    | "none";
}

export type PreviewSpec =
  | StylePreviewSpec
  | ThemePreviewSpec
  | HeaderPreviewSpec
  | DensityPreviewSpec
  | BottomMenuPreviewSpec;

export interface PreferenceOption {
  id: string;
  label: string;
  description: string;
  preview: PreviewSpec;
}

export interface PreferenceCategory {
  id: PreferenceCategoryId;
  label: string;
  prompt: string;
  options: PreferenceOption[];
}

export interface ProjectPreferences {
  style: string;
  theme: string;
  header: string;
  density: string;
  bottomMenu: string;
}

export const PREFERENCES_CATALOG: PreferenceCategory[] = [
  {
    id: "style",
    label: "Style",
    prompt: "Pick the overall look & feel",
    options: [
      {
        id: "basic",
        label: "Basic",
        description: "Clean Telegram-native feel. Safe default.",
        preview: {
          kind: "style",
          bg: "#ffffff",
          surface: "#f4f5f7",
          text: "#0f172a",
          textMuted: "#6b7280",
          primary: "#2563eb",
          primaryText: "#ffffff",
          accent: "#0ea5e9",
          border: "#e5e7eb",
          displayFont: "Inter",
          bodyFont: "Inter",
          radius: 12,
          shadow: "0 1px 2px rgba(15,23,42,0.08)",
        },
      },
      {
        id: "neon",
        label: "Neon",
        description: "Dark surfaces with glowing accents.",
        preview: {
          kind: "style",
          bg: "#08070f",
          surface: "#15122b",
          text: "#f8fafc",
          textMuted: "#a3a8c3",
          primary: "#7c3aed",
          primaryText: "#ffffff",
          accent: "#22d3ee",
          border: "#2a2350",
          displayFont: "Orbitron",
          bodyFont: "Inter",
          radius: 16,
          shadow: "0 0 24px rgba(124,58,237,0.45)",
        },
      },
      {
        id: "crypto",
        label: "Crypto",
        description: "DeFi-style dashboard. Bold numbers, ticker greens/reds.",
        preview: {
          kind: "style",
          bg: "#0b0f17",
          surface: "#111827",
          text: "#e5e7eb",
          textMuted: "#94a3b8",
          primary: "#10b981",
          primaryText: "#04130c",
          accent: "#f59e0b",
          border: "#1f2937",
          displayFont: "Space Grotesk",
          bodyFont: "JetBrains Mono",
          radius: 10,
          shadow: "0 8px 24px rgba(2,6,23,0.6)",
        },
      },
      {
        id: "minimal",
        label: "Minimal",
        description: "Lots of whitespace, mono accents, editorial.",
        preview: {
          kind: "style",
          bg: "#fafaf9",
          surface: "#ffffff",
          text: "#111111",
          textMuted: "#6b7280",
          primary: "#111111",
          primaryText: "#fafaf9",
          accent: "#111111",
          border: "#e7e5e4",
          displayFont: "Playfair Display",
          bodyFont: "Inter",
          radius: 4,
          shadow: "none",
        },
      },
      {
        id: "playful",
        label: "Playful",
        description: "Rounded shapes, warm palette, friendly icons.",
        preview: {
          kind: "style",
          bg: "#fff7ed",
          surface: "#ffffff",
          text: "#1f2937",
          textMuted: "#78716c",
          primary: "#f97316",
          primaryText: "#ffffff",
          accent: "#ec4899",
          border: "#fde68a",
          displayFont: "Fredoka",
          bodyFont: "Nunito",
          radius: 24,
          shadow: "0 6px 18px rgba(249,115,22,0.25)",
        },
      },
      {
        id: "nature",
        label: "Nature",
        description: "Calm greens, organic shapes, eco-friendly.",
        preview: {
          kind: "style",
          bg: "#f0fdf4",
          surface: "#ffffff",
          text: "#14532d",
          textMuted: "#4b7c5a",
          primary: "#16a34a",
          primaryText: "#ffffff",
          accent: "#4ade80",
          border: "#bbf7d0",
          displayFont: "DM Sans",
          bodyFont: "DM Sans",
          radius: 16,
          shadow: "0 4px 18px rgba(22,163,74,0.12)",
        },
      },
      {
        id: "corporate",
        label: "Corporate",
        description: "Formal, data-first dashboards. KPIs and tables.",
        preview: {
          kind: "style",
          bg: "#f8fafc",
          surface: "#ffffff",
          text: "#1e3a5f",
          textMuted: "#64748b",
          primary: "#2563eb",
          primaryText: "#ffffff",
          accent: "#1e3a5f",
          border: "#e2e8f0",
          displayFont: "Plus Jakarta Sans",
          bodyFont: "Plus Jakarta Sans",
          radius: 8,
          shadow: "0 1px 3px rgba(0,0,0,0.06)",
        },
      },
      {
        id: "paper",
        label: "Paper",
        description: "Tactile, printed feel — invoices, receipts, tickets.",
        preview: {
          kind: "style",
          bg: "#f5f0e8",
          surface: "#ede8df",
          text: "#1a1410",
          textMuted: "#9b8e7a",
          primary: "#1a1410",
          primaryText: "#f5f0e8",
          accent: "#c0392b",
          border: "rgba(0,0,0,0.10)",
          displayFont: "Syne",
          bodyFont: "Space Grotesk",
          radius: 4,
          shadow: "inset 0 0 0 1px rgba(0,0,0,0.07)",
        },
      },
      {
        id: "aurora",
        label: "Aurora",
        description: "Glassmorphism over a cyan/purple aurora nebula.",
        preview: {
          kind: "style",
          bg: "#050b1a",
          surface: "rgba(255,255,255,0.04)",
          text: "#ffffff",
          textMuted: "rgba(255,255,255,0.45)",
          primary: "#38bdf8",
          primaryText: "#ffffff",
          accent: "#a855f7",
          border: "rgba(255,255,255,0.08)",
          displayFont: "Space Grotesk",
          bodyFont: "Space Grotesk",
          radius: 24,
          shadow: "0 0 30px rgba(168,85,247,0.18)",
        },
      },
      {
        id: "brutalist",
        label: "Brutalist",
        description: "Hard borders, yellow accents, heavy typography. No apology.",
        preview: {
          kind: "style",
          bg: "#f0f0f0",
          surface: "#e0e0e0",
          text: "#000000",
          textMuted: "#666666",
          primary: "#000000",
          primaryText: "#ffe600",
          accent: "#ffe600",
          border: "#000000",
          displayFont: "Unbounded",
          bodyFont: "Unbounded",
          radius: 0,
          shadow: "4px 4px 0 #ffe600",
        },
      },
      {
        id: "liquid",
        label: "Liquid",
        description: "Living blobs, conic rings, cyan/mint biotech feel.",
        preview: {
          kind: "style",
          bg: "#03080f",
          surface: "rgba(0,200,255,0.05)",
          text: "rgba(255,255,255,0.9)",
          textMuted: "rgba(255,255,255,0.35)",
          primary: "#00c8ff",
          primaryText: "#ffffff",
          accent: "#00ffb4",
          border: "rgba(0,200,255,0.18)",
          displayFont: "Space Grotesk",
          bodyFont: "Space Grotesk",
          radius: 24,
          shadow: "0 0 30px rgba(0,200,255,0.15)",
        },
      },
      {
        id: "titanium",
        label: "Titanium",
        description: "Brushed metal, gradient text, premium without gold.",
        preview: {
          kind: "style",
          bg: "#111111",
          surface: "#1a1a1a",
          text: "#e8e8e8",
          textMuted: "#666666",
          primary: "#2a2a2a",
          primaryText: "#e8e8e8",
          accent: "#4ade80",
          border: "#1e1e1e",
          displayFont: "Space Grotesk",
          bodyFont: "Space Grotesk",
          radius: 20,
          shadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 4px 16px rgba(0,0,0,0.4)",
        },
      },
      {
        id: "signal",
        label: "Signal",
        description: "Terminal green on black, scanlines, monospace data.",
        preview: {
          kind: "style",
          bg: "#000000",
          surface: "rgba(0,255,70,0.04)",
          text: "#00ff46",
          textMuted: "rgba(0,255,70,0.35)",
          primary: "#00ff46",
          primaryText: "#000000",
          accent: "#00ffff",
          border: "rgba(0,255,70,0.20)",
          displayFont: "DM Mono",
          bodyFont: "DM Mono",
          radius: 6,
          shadow: "0 0 12px rgba(0,255,70,0.4)",
        },
      },
      {
        id: "holo",
        label: "Holo",
        description: "Sci-fi HUD — perspective grid, scan lines, ice blue.",
        preview: {
          kind: "style",
          bg: "#070b14",
          surface: "rgba(100,200,255,0.05)",
          text: "rgba(200,235,255,0.95)",
          textMuted: "rgba(100,200,255,0.5)",
          primary: "#64c8ff",
          primaryText: "#070b14",
          accent: "#64c8ff",
          border: "rgba(100,200,255,0.18)",
          displayFont: "Space Grotesk",
          bodyFont: "Space Grotesk",
          radius: 18,
          shadow: "0 0 30px rgba(50,180,255,0.15)",
        },
      },
    ],
  },
  {
    id: "theme",
    label: "Theme",
    prompt: "Light, dark, or follow Telegram",
    options: [
      { id: "light", label: "Light", description: "Always render the light palette of the chosen style.", preview: { kind: "theme", mode: "light" } },
      { id: "dark", label: "Dark", description: "Always render the dark palette of the chosen style.", preview: { kind: "theme", mode: "dark" } },
      { id: "auto", label: "Auto", description: "Match the user's Telegram color scheme.", preview: { kind: "theme", mode: "auto" } },
    ],
  },
  {
    id: "header",
    label: "Header",
    prompt: "How should the top of every screen look?",
    options: [
      { id: "minimal", label: "Minimal", description: "Title only, no chrome.", preview: { kind: "header", layout: "minimal" } },
      { id: "branded", label: "Branded", description: "Logo + title + action.", preview: { kind: "header", layout: "branded" } },
      { id: "large_title", label: "Large title", description: "iOS-style large title that collapses on scroll.", preview: { kind: "header", layout: "large_title" } },
    ],
  },
  {
    id: "density",
    label: "Density",
    prompt: "How tightly packed should lists feel?",
    options: [
      { id: "compact", label: "Compact", description: "More content per screen.", preview: { kind: "density", rowHeight: 44, gap: 8 } },
      { id: "comfortable", label: "Comfortable", description: "Roomy spacing, easier to tap.", preview: { kind: "density", rowHeight: 64, gap: 16 } },
    ],
  },
  {
    id: "bottomMenu",
    label: "Bottom menu",
    prompt: "How does the user navigate between sections?",
    options: [
      { id: "tabbar", label: "Flat tab bar", description: "Honest fixed bar — 4-5 icon+label tabs welded to the bottom edge.", preview: { kind: "bottomMenu", layout: "tabbar" } },
      { id: "tabbar_pill", label: "Floating pill", description: "Detached capsule that floats above the safe-area; active tab expands into a pill.", preview: { kind: "bottomMenu", layout: "tabbar_pill" } },
      { id: "tabbar_glass", label: "Liquid glass", description: "Frosted backdrop-blur bar with a slow specular sheen. Content shows through.", preview: { kind: "bottomMenu", layout: "tabbar_glass" } },
      { id: "tabbar_fab", label: "Flat + center FAB", description: "Flat 4-tab bar with a single hero action button rising above the center.", preview: { kind: "bottomMenu", layout: "tabbar_fab" } },
      { id: "floating_cta", label: "Floating CTA", description: "No tab bar — one floating action button only.", preview: { kind: "bottomMenu", layout: "floating_cta" } },
      { id: "action_grid", label: "Action grid", description: "Replace bottom nav with a grid of large action cards on Home.", preview: { kind: "bottomMenu", layout: "action_grid" } },
      { id: "none", label: "None", description: "Single-screen app, no nav at all.", preview: { kind: "bottomMenu", layout: "none" } },
    ],
  },
];

export const DEFAULT_PREFERENCES: ProjectPreferences = {
  style: "basic",
  theme: "auto",
  header: "minimal",
  density: "comfortable",
  bottomMenu: "tabbar",
};

const CATEGORY_KEYS: PreferenceCategoryId[] = [
  "style",
  "theme",
  "header",
  "density",
  "bottomMenu",
];

function findOption(
  catId: PreferenceCategoryId,
  optId: string | undefined | null,
): PreferenceOption | undefined {
  if (!optId) return undefined;
  const cat = PREFERENCES_CATALOG.find((c) => c.id === catId);
  if (!cat) return undefined;
  return cat.options.find((o) => o.id === optId);
}

// Cache for `agent_knowledge/preferences/<cat>/<opt>.md`. Restart the
// server to pick up edits — same convention as instruction files.
const ruleCache = new Map<string, string>();

function ruleCacheKey(catId: PreferenceCategoryId, optId: string): string {
  return `${catId}/${optId}`;
}

function loadOptionRules(catId: PreferenceCategoryId, optId: string): string {
  const key = ruleCacheKey(catId, optId);
  if (ruleCache.has(key)) return ruleCache.get(key)!;
  try {
    const filePath = path.join(PREFERENCES_DIR, catId, `${optId}.md`);
    // Defensive: make sure no .. tricks escape the preferences dir.
    if (!filePath.startsWith(PREFERENCES_DIR)) {
      ruleCache.set(key, "");
      return "";
    }
    const content = fs.readFileSync(filePath, "utf-8").trim();
    ruleCache.set(key, content);
    return content;
  } catch (err: any) {
    console.warn(`[Prefs] missing rules file: ${catId}/${optId}.md — ${err.message}`);
    ruleCache.set(key, "");
    return "";
  }
}

export interface ValidatePreferencesResult {
  ok: boolean;
  prefs: ProjectPreferences;
  errors: { key: string; reason: string }[];
}

/**
 * Parse + validate a raw preferences object/string.
 *
 * - Drops unknown ids and replaces them with defaults.
 * - Always returns a fully-populated `ProjectPreferences` so downstream
 *   prompt builders never see `undefined`.
 * - `ok` is true only if every key resolves to a known option.
 */
export function validatePreferences(
  raw: unknown,
): ValidatePreferencesResult {
  const errors: { key: string; reason: string }[] = [];
  let parsed: Record<string, unknown> = {};

  if (typeof raw === "string") {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === "object") parsed = j as Record<string, unknown>;
    } catch (err) {
      errors.push({ key: "_root", reason: "invalid_json" });
    }
  } else if (raw && typeof raw === "object") {
    parsed = raw as Record<string, unknown>;
  } else if (raw != null) {
    errors.push({ key: "_root", reason: "invalid_type" });
  }

  const prefs: ProjectPreferences = { ...DEFAULT_PREFERENCES };

  for (const key of CATEGORY_KEYS) {
    const incoming = parsed[key];
    if (incoming == null) continue;
    if (typeof incoming !== "string") {
      errors.push({ key, reason: "not_a_string" });
      continue;
    }
    // AUTO sentinel — user explicitly chose "let the AI decide" for this
    // category. Persist it as-is; downstream prompt builders skip it.
    if (incoming === AUTO_PREFERENCE) {
      prefs[key] = AUTO_PREFERENCE;
      continue;
    }
    const opt = findOption(key, incoming);
    if (!opt) {
      errors.push({ key, reason: `unknown_option:${incoming}` });
      continue;
    }
    prefs[key] = opt.id;
  }

  return { ok: errors.length === 0, prefs, errors };
}

/**
 * Build the strict, non-negotiable PREFERENCES block prepended to planner
 * and build-agent prompts. Always returns a non-empty string (defaults
 * are used if anything is missing). Reads each chosen option's rules from
 * `agent_knowledge/preferences/<cat>/<opt>.md` so writers can iterate on
 * the rules without touching code.
 */
export function buildPreferencesPrompt(
  prefs: ProjectPreferences | null | undefined,
): string {
  const safe = validatePreferences(prefs ?? {}).prefs;

  const sections: string[] = [];
  const autoCategories: string[] = [];
  for (const cat of PREFERENCES_CATALOG) {
    const value = safe[cat.id];
    if (value === AUTO_PREFERENCE) {
      autoCategories.push(cat.label);
      continue;
    }
    const opt = findOption(cat.id, value);
    if (!opt) continue;
    const rules = loadOptionRules(cat.id, opt.id);
    if (!rules) continue;
    sections.push(`### ${cat.label}: ${opt.label}\n${rules}`);
  }

  const lines = [
    "PROJECT PREFERENCES (MUST FOLLOW)",
    "",
    "The user has chosen the following visual preferences. They are non-negotiable.",
    "If anything in the plan or generated code conflicts with them, change the code, not the preferences.",
    "Do not introduce additional fonts, palettes, or layouts beyond what is listed here.",
    "",
    sections.join("\n\n"),
  ];

  if (autoCategories.length > 0) {
    lines.push("");
    lines.push(
      `For these axes the user delegated the choice to you — pick whatever fits the app idea best, but stay internally consistent: ${autoCategories.join(", ")}.`,
    );
  }

  return lines.join("\n");
}

/** Convenience: parse the JSON column into ProjectPreferences (or null). */
export function parseProjectPreferences(
  raw: string | null | undefined,
): ProjectPreferences | null {
  if (!raw) return null;
  const v = validatePreferences(raw);
  return v.prefs;
}
