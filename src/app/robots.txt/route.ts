import { robotsRules, robotsTxt } from "./rules";

// Read at every request: the indexing switch (SEO_INDEXING_ENABLED) is an environment variable
// that is flipped without a rebuild, like in /llms.txt and src/proxy.ts.
export const dynamic = "force-dynamic";

/**
 * `/robots.txt`. A Route Handler and not `app/robots.ts`: the metadata file answers with
 * `Cache-Control: max-age=0`, and Google shortens the time it keeps a robots.txt to that value
 * (24 hours otherwise). Googlebot was asking for the file about 22 times a day (321 requests in 15
 * days, November 2026), each one reading the database for the list of sales sitemaps. One hour for
 * crawlers, five minutes for the CDN: the switch still takes effect quickly.
 */
export async function GET() {
  return new Response(robotsTxt(await robotsRules()), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
