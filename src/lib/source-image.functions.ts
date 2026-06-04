import { createServerFn } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

const inputSchema = z.object({
  url: z.string().url(),
});

export type SourceImageResult = {
  ok: boolean;
  imageUrl: string | null;
  error: string | null;
};

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absolutize(src: string, base: string): string | null {
  try {
    return new URL(src, base).toString();
  } catch {
    return null;
  }
}

function extractMeta(html: string, property: string): string | null {
  // og:image, twitter:image — property OR name attribute
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return null;
}

function extractFirstImg(html: string): string | null {
  // Avoid pixels/spacers: skip data: URIs and obvious 1x1 tracking
  const re = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (!src || src.startsWith("data:")) continue;
    const tag = m[0];
    // skip tiny tracking pixels
    if (/width=["']?1["']?/i.test(tag) || /height=["']?1["']?/i.test(tag)) continue;
    if (/sprite|logo|icon|pixel|tracker|placeholder/i.test(src)) continue;
    return decodeEntities(src);
  }
  return null;
}

export const getSourceImage = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => inputSchema.parse(input))
  .handler(async ({ data }): Promise<SourceImageResult> => {
    // Cache 7 days — source pages rarely change their hero image
    setResponseHeaders(new Headers({ "cache-control": "public, max-age=604800" }));

    try {
      const res = await fetch(data.url, {
        signal: AbortSignal.timeout(8_000),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; EncheresImmoBot/1.0; +https://encheres-immo.app)",
          accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
      });
      if (!res.ok) {
        return { ok: false, imageUrl: null, error: `HTTP ${res.status}` };
      }
      const html = (await res.text()).slice(0, 500_000); // cap 500KB

      const candidate =
        extractMeta(html, "og:image:secure_url") ||
        extractMeta(html, "og:image") ||
        extractMeta(html, "twitter:image") ||
        extractMeta(html, "twitter:image:src") ||
        extractFirstImg(html);

      if (!candidate) {
        return { ok: true, imageUrl: null, error: null };
      }
      const abs = absolutize(candidate, res.url || data.url);
      if (!abs || !/^https?:/i.test(abs)) {
        return { ok: true, imageUrl: null, error: null };
      }
      return { ok: true, imageUrl: abs, error: null };
    } catch (err) {
      return {
        ok: false,
        imageUrl: null,
        error: err instanceof Error ? err.message : "fetch failed",
      };
    }
  });
