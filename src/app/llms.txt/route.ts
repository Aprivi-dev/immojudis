import { buildLlmsTxt } from "@/lib/llms-txt";
import { isSiteIndexable } from "@/lib/seo-indexing";
import { resolveSiteOrigin } from "@/lib/site-url";

// Read at every request: the indexing switch (SEO_INDEXING_ENABLED) is an environment variable
// that is flipped without a rebuild, like in robots.ts and src/proxy.ts.
export const dynamic = "force-dynamic";

const TEXT = "text/plain; charset=utf-8";

/**
 * `/llms.txt`: a summary of Immojudis and the list of its editorial pages (never a sale page).
 *
 * It follows the same decision as `robots.txt` (`isSiteIndexable`): while the site is closed to
 * search engines (switch off, or a Vercel preview) there is nothing to advertise, so the answer
 * is a plain 404, not a list. src/proxy.ts still adds its `X-Robots-Tag` header to both answers.
 */
export function GET() {
  if (!isSiteIndexable()) {
    return new Response("Not found\n", { status: 404, headers: { "content-type": TEXT } });
  }
  const origin = resolveSiteOrigin(process.env, "http://localhost:3000")!;
  return new Response(buildLlmsTxt(origin), {
    headers: {
      "content-type": TEXT,
      // Short shared cache: the switch can be flipped at any time and must take effect quickly.
      "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
