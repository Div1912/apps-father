import type OpenAI from "openai";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { config } from "../../../../../config";
import { runtimeConfig } from "../../../../runtime-config.service";
import { BUCKET_ROOT } from "../../../../../web/routes/bucket.routes";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const VALID_ASPECT_RATIOS = new Set([
  "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
]);

function ensureBucketDir(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(BUCKET_ROOT, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sanitizeFilename(raw: string): string {
  let name = String(raw || "image.png").replace(/[^a-zA-Z0-9_.-]/g, "-");
  if (!name.match(/\.[a-z]+$/i)) name += ".png";
  name = name.replace(/\.(?!png$)[^.]+$/, ".png"); // force .png extension
  return name || "generated.png";
}

export class ImageGenerateTool implements AgentTool {
  // Stored after execute() so getStepMeta() can include it for UI display.
  private _lastImage: { base64: string; filename: string; directLink: string } | null = null;

  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "image_generate",
        description: [
          "Generate an AI image (banner, illustration, background, icon, UI asset) and save it",
          "directly to the project bucket. Once saved, reference it in HTML/CSS as:",
          "  <img src='/bucket/{projectId}/{filename}'>  or  background-image: url('/bucket/{projectId}/{filename}')",
          "Plan filenames in your technical_plan so they can be referenced in code before generation.",
          "Use at most 3 images per session.",
          "IMPORTANT — background blending: Generated images always have a solid background color.",
          "For ANY image that sits ON TOP of the app UI (illustrations, characters, icons, cards):",
          "  → ALWAYS pass background_rgb_color matching the app's CSS background (e.g. if bg is #111827, pass [17,24,39]).",
          "  Without this the image gets a white/gray box that looks terrible on dark themes.",
          "For full-bleed banners/heroes that FILL their container: background_rgb_color is part of the design.",
          "Use recraft-v4-pro (default, no style param) for photorealistic/high-quality visuals,",
          "or add a 'style' param (e.g. 'Illustration', 'Vector art', 'Pixel art') to use Recraft V3.",
        ].join(" "),
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "Detailed image description. Include subject, mood, colors, style, composition. More detail = better results.",
            },
            filename: {
              type: "string",
              description:
                "Filename to save (e.g. 'hero-banner.png', 'icon-wallet.png'). Must end with .png. Use the same name when referencing in code.",
            },
            aspect_ratio: {
              type: "string",
              enum: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
              description:
                "Image aspect ratio. 16:9 for banners/headers, 1:1 for avatars/icons, 9:16 for portrait heroes, 21:9 for ultrawide.",
            },
            style: {
              type: "string",
              description:
                "Visual style — switches model to Recraft V3 (supports styles). Options: 'Illustration', 'Photorealism', 'Vector art', 'Hand-drawn', 'Pixel art', '3D render', 'Grain', 'Watercolor', 'Bold fantasy', 'Risograph', 'Retro Pop', 'Clay', etc. Omit to use V4 Pro (highest photorealistic quality).",
            },
            rgb_colors: {
              type: "array",
              items: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 },
              description:
                "Color palette hints as [[r,g,b], ...] (values 0-255). Up to 5 colors that should appear in the image.",
            },
            background_rgb_color: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 3,
              description:
                "REQUIRED for any image placed on the app UI. Solid background color as [r,g,b] (0-255). Must match the app's CSS background color exactly so the image blends seamlessly. E.g. dark theme #0d1117 → [13,17,23], #111827 → [17,24,39], #1a1a2e → [26,26,46].",
            },
          },
          required: ["prompt", "filename"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    this._lastImage = null;

    const { prompt, filename, aspect_ratio, style, rgb_colors, background_rgb_color } = args;

    const fname = sanitizeFilename(filename);
    const useStyle = typeof style === "string" && style.trim().length > 0;
    const model = useStyle ? "recraft/recraft-v3" : "recraft/recraft-v4-pro";

    await ctx.progress({
      action: "🎨 Generating image",
      detail: `${fname}${useStyle ? ` · ${style}` : ""}${aspect_ratio ? ` · ${aspect_ratio}` : ""}`,
      percent: ctx.currentPercent,
    });

    const apiKey = runtimeConfig.getOpenRouterApiKey() || config.openrouterApiKey;
    if (!apiKey) return "Error: No OpenRouter API key configured.";

    // Build image_config
    const image_config: Record<string, any> = { image_size: "1K" };
    if (aspect_ratio && VALID_ASPECT_RATIOS.has(aspect_ratio)) {
      image_config.aspect_ratio = aspect_ratio;
    }
    if (Array.isArray(rgb_colors) && rgb_colors.length > 0) {
      image_config.rgb_colors = rgb_colors.slice(0, 5);
    }
    if (Array.isArray(background_rgb_color) && background_rgb_color.length === 3) {
      image_config.background_rgb_color = background_rgb_color;
    }
    if (useStyle) {
      image_config.style = style.trim();
    }

    try {
      const body = {
        model,
        messages: [{ role: "user", content: String(prompt) }],
        modalities: ["image"],
        image_config,
      };

      console.log(`[ImageGenerate] Calling ${model} for "${fname}" (${aspect_ratio || "1:1"})`);

      const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": `https://${config.domain}`,
          "X-Title": "Apps Father",
        },
        body: JSON.stringify(body),
        // Image generation can take up to 60s
        signal: AbortSignal.timeout(90_000),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        console.error(`[ImageGenerate] API error ${resp.status}:`, errText.slice(0, 400));
        return `Error: Image generation API returned ${resp.status}: ${errText.slice(0, 300)}`;
      }

      const data = await resp.json() as Record<string, any>;

      // OpenRouter returns image in choices[0].message.images[0].image_url.url (data URL)
      const imgUrl: string | undefined =
        data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ??
        data?.choices?.[0]?.message?.images?.[0]?.imageUrl?.url;

      if (!imgUrl) {
        console.error("[ImageGenerate] No image in response:", JSON.stringify(data).slice(0, 500));
        return `Error: No image returned by API. Check model/prompt. Response snippet: ${JSON.stringify(data).slice(0, 200)}`;
      }

      // Decode base64 data URL → Buffer
      const base64 = imgUrl.replace(/^data:image\/[a-z]+;base64,/, "");
      const buf = Buffer.from(base64, "base64");

      // Save to bucket with the requested filename
      const bucketDir = ensureBucketDir(ctx.projectId);
      const filePath = path.join(bucketDir, fname);
      fs.writeFileSync(filePath, buf);

      const directLink = `/bucket/${ctx.projectId}/${fname}`;
      const kb = Math.round(buf.length / 1024);
      console.log(`[ImageGenerate] ✅ Saved ${fname} (${kb}KB) → ${directLink}`);

      this._lastImage = { base64, filename: fname, directLink };

      return [
        `OK: Image generated and saved.`,
        `URL: ${directLink}`,
        `Size: ${kb}KB | Model: ${model}${aspect_ratio ? ` | Ratio: ${aspect_ratio}` : ""}`,
        `Use in HTML: <img src="${directLink}" alt="...">`,
        `Use in CSS:  background-image: url('${directLink}');`,
      ].join("\n");
    } catch (err: any) {
      console.error("[ImageGenerate] Error:", err);
      if (err?.name === "TimeoutError") {
        return "Error: Image generation timed out after 90 seconds. Try a simpler prompt.";
      }
      return `Error: ${err.message}`;
    }
  }

  getStepMeta(args: Record<string, any>): Record<string, any> {
    const meta: Record<string, any> = {
      filename: sanitizeFilename(args?.filename || "image.png"),
    };
    if (args?.aspect_ratio) meta.aspectRatio = args.aspect_ratio;
    if (args?.style) meta.style = args.style;
    if (this._lastImage) {
      meta.imageBase64 = this._lastImage.base64;
      meta.directLink = this._lastImage.directLink;
    }
    return meta;
  }
}
