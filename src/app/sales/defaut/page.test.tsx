import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/public-catalogue.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-catalogue.server")>(
    "@/lib/public-catalogue.server",
  );
  return { ...actual, loadInitialCatalogue: mocks.load };
});
vi.mock("../sales-page", () => ({
  SalesPage: ({ serverSeeded }: { serverSeeded: boolean }) => (
    <main data-seeded={String(serverSeeded)}>
      <h1>Ventes immobilières aux enchères</h1>
    </main>
  ),
}));
vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    HydrationBoundary: ({ state, children }: { state: unknown; children: React.ReactNode }) => (
      <div data-state={JSON.stringify(state)}>{children}</div>
    ),
  };
});

import Page, { dynamic, metadata, revalidate } from "./page";
import { generateMetadata as dynamicPageMetadata } from "../page";
import { FIRST_PAGE_REVALIDATE_SECONDS } from "@/lib/public-catalogue.server";
import { salesSearchSignature } from "@/lib/search/search-url-state";

describe("/sales static variant (ISR)", () => {
  beforeEach(() => mocks.load.mockReset());

  it("is regenerated every 5 minutes, like the cached first page, and rendered statically", () => {
    expect(revalidate).toBe(FIRST_PAGE_REVALIDATE_SECONDS);
    // `force-static`: `useSearchParams()` renders empty parameters instead of handing the page back
    // to the browser, and the root layout's `connection()` cannot make it dynamic (no nonce here,
    // so the proxy does not rewrite to this page while the nonce CSP is served).
    expect(dynamic).toBe("force-static");
    // Next.js reads these two from the source text: they must stay literals.
    const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8");
    expect(source).toMatch(/^export const revalidate = 300;$/m);
    expect(source).toMatch(/^export const dynamic = "force-static";$/m);
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/searchParams|connection\(|headers\(|cookies\(/);
  });

  it("carries exactly the metadata of the page rendered on demand (canonical /sales, no robots)", async () => {
    expect(metadata).toEqual(await dynamicPageMetadata({ searchParams: Promise.resolve({}) }));
    expect(metadata.alternates).toEqual({ canonical: "/sales" });
    expect(metadata.robots).toBeUndefined();
  });

  it("seeds the first page of the unfiltered catalogue, as the dynamic page does for /sales", async () => {
    mocks.load.mockResolvedValue({
      signature: salesSearchSignature({}),
      items: [{ id: "a" }],
      count: 2276,
    });
    const html = renderToStaticMarkup(await Page());
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(salesSearchSignature(mocks.load.mock.calls[0][0])).toBe(salesSearchSignature({}));
    // Regeneration waits longer for the photo copies than a visitor's request does (300 ms).
    expect(mocks.load.mock.calls[0][1]).toEqual({ photoMirrorTimeoutMs: 1_500 });
    expect(html).toContain('data-seeded="true"');
    expect(html).toContain("<h1>Ventes immobilières aux enchères</h1>");
  });

  it("hands the rows over as fresh for the whole life of the page, so the browser does not search again", async () => {
    mocks.load.mockResolvedValue({
      signature: salesSearchSignature({}),
      items: [{ id: "a" }],
      count: 1,
    });
    const before = Date.now();
    const html = renderToStaticMarkup(await Page());
    const raw = /data-state="([^"]*)"/.exec(html)![1].replaceAll("&quot;", '"');
    const queries = (JSON.parse(raw) as { queries: Array<{ state: { dataUpdatedAt: number } }> })
      .queries;
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      // Generated at `before`, served for 5 minutes: still fresh (browser staleTime on top) at the end.
      expect(query.state.dataUpdatedAt).toBeGreaterThanOrEqual(
        before + FIRST_PAGE_REVALIDATE_SECONDS * 1000,
      );
      expect(query.state.dataUpdatedAt).toBeLessThanOrEqual(
        Date.now() + FIRST_PAGE_REVALIDATE_SECONDS * 1000,
      );
    }
  });

  it("still renders when the database is unavailable in development and tests: the browser takes over", async () => {
    mocks.load.mockResolvedValue(null);
    const html = renderToStaticMarkup(await Page());
    expect(html).toContain('data-seeded="false"');
  });

  describe("database outage in production", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("fails the regeneration instead of caching an empty page for 5 minutes", async () => {
      // Next.js then keeps serving the last successfully generated page and retries on the next
      // request (ISR guide: "If an error is thrown while attempting to revalidate…").
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PHASE", "");
      mocks.load.mockResolvedValue(null);
      await expect(Page()).rejects.toThrow(/Catalogue public indisponible/);
    });

    it("still renders the page without a list during `next build`, so a build without database passes", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PHASE", "phase-production-build");
      mocks.load.mockResolvedValue(null);
      const html = renderToStaticMarkup(await Page());
      expect(html).toContain('data-seeded="false"');
    });

    it("renders normally when the database answers", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PHASE", "");
      mocks.load.mockResolvedValue({
        signature: salesSearchSignature({}),
        items: [{ id: "a" }],
        count: 1,
      });
      expect(renderToStaticMarkup(await Page())).toContain('data-seeded="true"');
    });
  });
});
