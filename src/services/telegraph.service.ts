const API = "https://api.telegra.ph";

let accessToken: string | null = null;

type TelegraphNode = string | { tag: string; attrs?: Record<string, string>; children?: TelegraphNode[] };

async function getToken(): Promise<string> {
  if (accessToken) return accessToken;

  const res = await fetch(`${API}/createAccount`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      short_name: "AppsFather",
      author_name: "Apps Father",
      author_url: "https://t.me/apps_father_bot",
    }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; result: { access_token: string } };
  if (!data.ok) throw new Error(`Telegraph createAccount failed: ${data.error}`);
  accessToken = data.result.access_token;
  return accessToken;
}

function markdownToNodes(md: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  const lines = md.split("\n");
  let ulItems: TelegraphNode[][] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  function flushUl() {
    if (ulItems.length > 0) {
      nodes.push({ tag: "ul", children: ulItems.map(children => ({ tag: "li", children })) });
      ulItems = [];
    }
  }

  function flushCode() {
    if (codeLines.length > 0) {
      nodes.push({ tag: "pre", children: [codeLines.join("\n")] });
      codeLines = [];
    }
  }

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        flushUl();
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!trimmed) {
      flushUl();
      continue;
    }

    const h1 = trimmed.match(/^# (.+)/);
    if (h1) {
      flushUl();
      nodes.push({ tag: "h3", children: inlineFormat(h1[1]) });
      continue;
    }

    const h2 = trimmed.match(/^## (.+)/);
    if (h2) {
      flushUl();
      nodes.push({ tag: "h4", children: inlineFormat(h2[1]) });
      continue;
    }

    const h3 = trimmed.match(/^### (.+)/);
    if (h3) {
      flushUl();
      nodes.push({ tag: "h4", children: inlineFormat(h3[1]) });
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)/);
    if (bullet) {
      ulItems.push(inlineFormat(bullet[1]));
      continue;
    }

    const numbered = trimmed.match(/^\d+\.\s+(.+)/);
    if (numbered) {
      ulItems.push(inlineFormat(numbered[1]));
      continue;
    }

    flushUl();
    nodes.push({ tag: "p", children: inlineFormat(trimmed) });
  }

  flushUl();
  flushCode();
  return nodes;
}

function inlineFormat(text: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g);

  for (const part of parts) {
    if (!part) continue;

    const bold = part.match(/^\*\*(.+)\*\*$/);
    if (bold) {
      nodes.push({ tag: "b", children: [bold[1]] });
      continue;
    }

    const code = part.match(/^`(.+)`$/);
    if (code) {
      nodes.push({ tag: "code", children: [code[1]] });
      continue;
    }

    const italic = part.match(/^\*(.+)\*$/) || part.match(/^_(.+)_$/);
    if (italic) {
      nodes.push({ tag: "i", children: [italic[1]] });
      continue;
    }

    nodes.push(part);
  }

  return nodes;
}

export async function publishReport(title: string, summary: string): Promise<string> {
  const token = await getToken();

  const content: TelegraphNode[] = markdownToNodes(summary);

  if (content.length === 0) {
    content.push({ tag: "p", children: ["No summary available."] });
  }

  const res = await fetch(`${API}/createPage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: token,
      title,
      author_name: "Apps Father",
      author_url: "https://t.me/apps_father_bot",
      content,
    }),
  });

  const data = (await res.json()) as { ok: boolean; error?: string; result: { url: string } };
  if (!data.ok) throw new Error(`Telegraph createPage failed: ${data.error}`);
  return data.result.url;
}
