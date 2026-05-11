/**
 * Server-side security validator for user-generated project code.
 *
 * Blocks deploy if backend/routes.js contains patterns that would let user
 * code escape the project sandbox and attack the host platform (e.g. spawn
 * shells, mutate /etc, read platform secrets, exfiltrate the encryption key).
 *
 * Runs at deploy_to_dev and again at release-to-prod, so a malicious or
 * compromised code-generator cannot ship a backdoor even if it bypasses the
 * agent's own self-checks.
 */

export interface SecurityFinding {
  pattern: string;
  description: string;
  line: number;
  snippet: string;
  severity: "critical" | "high";
}

interface SecurityRule {
  id: string;
  description: string;
  severity: "critical" | "high";
  regex: RegExp;
}

const RULES: SecurityRule[] = [
  // ── Shell execution ──────────────────────────────────────────────────────
  {
    id: "child_process",
    description: "require('child_process') is not allowed in project code. Shell execution can compromise the host. Ask the platform for an admin/exec feature instead.",
    severity: "critical",
    regex: /require\s*\(\s*["'`]child_process["'`]\s*\)/,
  },
  {
    id: "dynamic_import_child_process",
    description: "Dynamic import of child_process is not allowed in project code.",
    severity: "critical",
    regex: /import\s*\(\s*["'`]child_process["'`]\s*\)/,
  },
  {
    id: "worker_threads",
    description: "require('worker_threads') is not allowed — workers can bypass sandbox restrictions.",
    severity: "critical",
    regex: /require\s*\(\s*["'`]worker_threads["'`]\s*\)/,
  },
  {
    id: "cluster_module",
    description: "require('cluster') is not allowed in project code.",
    severity: "critical",
    regex: /require\s*\(\s*["'`]cluster["'`]\s*\)/,
  },

  // ── Code-execution primitives ────────────────────────────────────────────
  {
    id: "vm_module",
    description: "require('vm') is not allowed — vm.runIn* can be used to escape the sandbox.",
    severity: "critical",
    regex: /require\s*\(\s*["'`]vm["'`]\s*\)/,
  },
  {
    id: "eval_call",
    description: "eval() is not allowed in project code.",
    severity: "critical",
    regex: /\beval\s*\(/,
  },
  {
    id: "function_constructor",
    description: "new Function('...') is not allowed — equivalent to eval().",
    severity: "critical",
    regex: /\bnew\s+Function\s*\(/,
  },

  // ── Node internals that bypass require() hooks ───────────────────────────
  {
    id: "process_binding",
    description: "process.binding() exposes raw native bindings and is not allowed.",
    severity: "critical",
    regex: /\bprocess\s*\.\s*binding\s*\(/,
  },
  {
    id: "process_dlopen",
    description: "process.dlopen() loads native shared libraries and is not allowed.",
    severity: "critical",
    regex: /\bprocess\s*\.\s*dlopen\s*\(/,
  },
  {
    id: "module_constructor_load",
    description: "module.constructor._load() bypasses the require() hook and is not allowed.",
    severity: "critical",
    regex: /module\s*\.\s*constructor\s*\.\s*_load\s*\(/,
  },
  {
    id: "module_prototype",
    description: "Module.prototype._compile is not allowed — it can execute arbitrary code.",
    severity: "critical",
    regex: /Module\s*\.\s*prototype\s*\.\s*_(?:compile|load)\b/,
  },

  // ── Filesystem escape ────────────────────────────────────────────────────
  {
    id: "fs_write_etc",
    description: "Writing to /etc, /root, /var, /usr or /opt outside the project is not allowed.",
    severity: "critical",
    regex: /fs\s*\.\s*(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rename|renameSync|symlink|symlinkSync|chmod|chmodSync|chown|chownSync)\s*\(\s*["'`]\/(?:etc|root|var|usr|opt|home|boot|sbin)\b/,
  },
  {
    id: "fs_read_secrets",
    description: "Reading /etc/passwd, /etc/shadow, .ssh keys, or platform .env files is not allowed.",
    severity: "critical",
    regex: /fs\s*\.\s*(?:readFile|readFileSync|createReadStream)\s*\(\s*["'`](?:\/etc\/(?:passwd|shadow|sudoers)|\/root\/\.ssh\/|[^"'`]*\/\.ssh\/|[^"'`]*\/apps-father\/\.env)/,
  },
  {
    id: "symlink_traversal",
    description: "fs.symlink* is not allowed — symlinks can be used to escape the project directory.",
    severity: "high",
    regex: /fs\s*\.\s*symlink(?:Sync)?\s*\(/,
  },

  // ── Platform secret access ──────────────────────────────────────────────
  {
    id: "platform_secrets",
    description: "Project code may not read platform secrets (ENCRYPTION_KEY / WALLET_MNEMONIC / ADMIN_PASSWORD / AF_INTERNAL_SECRET / WEBHOOK_SECRET / DATABASE_URL / APPS_FATHER_TOKEN).",
    severity: "critical",
    regex: /\bprocess\s*\.\s*env\s*[\.\[]\s*["'`]?(?:ENCRYPTION_KEY|WALLET_MNEMONIC|ADMIN_PASSWORD|AF_INTERNAL_SECRET|WEBHOOK_SECRET|DATABASE_URL|APPS_FATHER_TOKEN|CRYPTO_BOT_TOKEN|NOWPAYMENTS_API_KEY|NOWPAYMENTS_IPN_SECRET|TONCENTER_API_KEY)\b/,
  },

  // ── System mutation through shell strings ───────────────────────────────
  {
    id: "useradd_command",
    description: "useradd / userdel / usermod / passwd / chpasswd commands are not allowed.",
    severity: "critical",
    regex: /["'`][^"'`]*\b(?:useradd|userdel|usermod|chpasswd|passwd\s+-)\b/,
  },
  {
    id: "sudoers_write",
    description: "Modifying /etc/sudoers or /etc/sudoers.d/ is not allowed.",
    severity: "critical",
    regex: /\/etc\/sudoers(?:\.d)?\b/,
  },
  {
    id: "reverse_shell",
    description: "Reverse shell patterns (bash -i, nc -e, /dev/tcp) are not allowed.",
    severity: "critical",
    regex: /bash\s+-i\b|\bnc\s+(?:-l|.*-e\s+\/bin)|\/dev\/tcp\/\d/,
  },
  {
    id: "curl_pipe_shell",
    description: "Piping curl/wget output into a shell is not allowed.",
    severity: "critical",
    regex: /(?:curl|wget)\s+[^"'`\n]*\|\s*(?:bash|sh|zsh|ksh|python|node)\b/,
  },

  // ── Memory / heap inspection (secret exfiltration) ──────────────────────
  {
    id: "heap_snapshot",
    description: "v8.getHeapSnapshot() is not allowed — heap dumps expose all in-memory secrets.",
    severity: "critical",
    regex: /v8\s*\.\s*(?:getHeapSnapshot|writeHeapSnapshot|setFlagsFromString)\s*\(/,
  },

  // ── Timer-as-eval ───────────────────────────────────────────────────────
  {
    id: "settimeout_string",
    description: "setTimeout / setInterval with a string argument is not allowed (acts as eval).",
    severity: "high",
    regex: /set(?:Timeout|Interval|Immediate)\s*\(\s*["'`]/,
  },
];

const SUSPICIOUS_NETWORK_HOSTS = [
  /127\.0\.0\.1/,
  /\blocalhost\b/,
  /169\.254\.169\.254/, // cloud metadata endpoint
];

const NETWORK_REQUEST_HINTS = /\b(?:fetch|axios|http\s*\.\s*(?:get|post|request)|https\s*\.\s*(?:get|post|request)|got|superagent)\b/;

/**
 * Scan a single file for dangerous patterns.
 * Returns an empty array if the file is safe.
 */
export function scanFileForBackdoors(content: string): SecurityFinding[] {
  if (!content) return [];

  const lines = content.split("\n");
  const findings: SecurityFinding[] = [];

  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue;
      }
      if (rule.regex.test(line)) {
        findings.push({
          pattern: rule.id,
          description: rule.description,
          line: i + 1,
          snippet: trimmed.slice(0, 160),
          severity: rule.severity,
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (!NETWORK_REQUEST_HINTS.test(line)) continue;
    for (const re of SUSPICIOUS_NETWORK_HOSTS) {
      if (re.test(line)) {
        findings.push({
          pattern: "internal_network_call",
          description: "Project code may not call internal/loopback/metadata hosts (localhost, 127.0.0.1, 169.254.169.254). These endpoints expose platform internals.",
          line: i + 1,
          snippet: trimmed.slice(0, 160),
          severity: "high",
        });
        break;
      }
    }
  }

  return findings;
}

/**
 * Validate the security of a backend/routes.js file before deploy.
 * Returns null when the file is safe, or a human-readable error string when
 * dangerous patterns are detected. The error string is intended to be shown
 * back to the agent so it can rewrite the file without the offending code.
 */
export function validateRoutesSecurity(routesContent: string): string | null {
  const findings = scanFileForBackdoors(routesContent);
  if (findings.length === 0) return null;

  const lines: string[] = [
    `Security validator BLOCKED deploy — backend/routes.js contains ${findings.length} forbidden pattern(s):`,
  ];
  for (const f of findings.slice(0, 10)) {
    lines.push(`  • [line ${f.line}] ${f.pattern}: ${f.description} (code: \`${f.snippet}\`)`);
  }
  if (findings.length > 10) {
    lines.push(`  • …and ${findings.length - 10} more.`);
  }
  lines.push(
    `Project code runs on the shared platform host — these patterns are forbidden because they can be used to escape the project sandbox, attack other apps, or steal platform secrets. Rewrite backend/routes.js without them and redeploy.`,
  );
  return lines.join("\n");
}
