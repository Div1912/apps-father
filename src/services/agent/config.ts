export const BLOCKED_COMMANDS = [
  "rm -rf /", "shutdown", "reboot", "mkfs", "dd if=",
  "chmod 777 /", "chown", "passwd", "useradd", "userdel",
  "systemctl", "service ", "kill -9 1", "pkill",
];

export const BLOCKED_INFRA_SHELL_PATTERNS = [
  /\bfind\s+\//i,
  /\/opt\/apps-father-dev\/(?:dist|projects)/i,
  /\b(?:ps|netstat|ss|lsof)\b/i,
  /\blocalhost:\d+\b/i,
];

/**
 * Package-manager invocations that the shell tool refuses outright. The agent
 * must use `npm_install` (which validates against runner-npm-allowlist.json)
 * to add runtime deps. Direct npm/pnpm/yarn/npx calls would bypass the
 * allowlist and let the agent (or a prompt-injected user message) pull
 * arbitrary packages — the #1 supply-chain risk on the runner.
 */
export const BLOCKED_PACKAGE_MANAGER_PATTERNS = [
  /(^|[\s;&|])(?:npm|pnpm|yarn|npx|bun)\b/i,
  /(^|[\s;&|])node\s+(?:--require|-r)\s+/i,
];

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "data",
]);

export const SKIP_EXTS = new Set([
  ".mp3", ".png", ".jpg", ".jpeg", ".gif", ".wav", ".mp4", ".webp", ".db",
]);

// Binary / non-text file extensions that must NEVER be read as UTF-8.
// Reading these as text injects ~1 token per byte of garbage into the LLM
// context (a 626KB JPEG = ~419k tokens). Always refuse with a structured note.
export const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".tif",
  ".heic", ".heif", ".avif", ".psd", ".raw",
  ".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".flv", ".wmv",
  ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".opus", ".wma",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".class", ".jar", ".pyc", ".o", ".a", ".node", ".wasm",
]);

// Hard cap on bytes read by read_file. Anything larger gets refused with
// guidance to use offset/limit.
export const READ_FILE_MAX_BYTES = 512 * 1024;

// Lower cap on bytes returned per call. Keeps any single read well below 100k tokens.
export const READ_FILE_SOFT_CAP_BYTES = 256 * 1024;

// Passport regen cadence: every Nth commit performs full LLM regen; commits in
// between use the cheap append-only delta path. Commit 0 always regens.
export const PASSPORT_REGEN_EVERY = 5;
