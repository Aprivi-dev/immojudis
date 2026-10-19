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
vi.mock("../../sales-page", () => ({
  SalesPage: ({ serverSeeded, staticQuery }: { serverSeeded: boolean; staticQuery?: string }) => (
    <main data-seeded={String(serverSeeded)} data-static-query={staticQuery}>
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

import Page, {
  dynamic,
  dynamicParams,
  generateMetadata,
  generateStaticParams,
  revalidate,
} from "./page";
import { FIRST_PAGE_REVALIDATE_SECONDS } from "@/lib/public-catalogue.server";
import { SALES_ISR_PAGES } from "@/lib/sales-isr";
import { salesSearchSignature } from "@/lib/search/search-url-state";

const params = (page: string) => ({ params: Promise.resolve({ page }) });

describe("/sales?page=N static variant (ISR)", () => {
  beforeEach(() => mocks.load.mockReset());

  it("is regenerated every 5 minutes like the first page, and rendered statically", () => {
    expect(revalidate).toBe(FIRST_PAGE_REVALIDATE_SECONDS);
    expect(dynamic).toBe("force-static");
    // Next.js reads these from the source text: they must stay literals.
    const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8");
    expect(source).toMatch(/^export const revalidate = 300;$/m);
    expect(source).toMatch(/^export const dynamic = "force-static";$/m);
    expect(source).toMatch(/^export const dynamicParams = false;$/m);
  });

  it("reads nothing that varies by visitor: no cookie, no header, no search parameter", () => {
    // The HTML is cached and shared between all visitors: it may only depend on the page number.
    const source = readFileSync(resolve(__dirname, "page.tsx"), "utf8");
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/searchParams|connection\(|headers\(|cookies\(|draftMode/);
    // Neither does the shared code it renders with.
    const catalogue = readFileSync(resolve(__dirname, "../../sales-catalogue.tsx"), "utf8");
    expect(catalogue.replace(/^\s*\/\/.*$/gm, "")).not.toMatch(
      /connection\(|headers\(|cookies\(|draftMode/,
    );
  });

  it("builds exactly the pages the proxy rewrites to, and nothing else", () => {
    expect(generateStaticParams()).toEqual(SALES_ISR_PAGES.map((page) => ({ page: String(page) })));
    expect(generateStaticParams()).toEqual([{ page: "2" }, { page: "3" }]);
    expect(dynamicParams).toBe(false);
  });

  it("has its own canonical and title, as the page rendered on demand for the same address", async () => {
    const metadata = await generateMetadata(params("2"));
    expect(metadata.alternates).toEqual({ canonical: "/sales?page=2" });
    expect(metadata.title).toEqual({
      absolute: "Ventes immobilières aux enchères en France - page 2",
    });
    expect(metadata.robots).toBeUndefined();
  });

  it("seeds page N of the unfiltered catalogue and tells the page which address it stands for", async () => {
    mocks.load.mockResolvedValue({
      signature: salesSearchSignature({ page: 3 }),
      items: [{ id: "a" }],
      count: 2276,
    });
    const html = renderToStaticMarkup(await Page(params("3")));
    expect(mocks.load).toHaveBeenCalledTimes(1);
    expect(mocks.load.mock.calls[0][0]).toMatchObject({ page: 3 });
    expect(salesSearchSignature(mocks.load.mock.calls[0][0])).toBe(
      salesSearchSignature({ page: 3 }),
    );
    expect(html).toContain('data-seeded="true"');
    // `useSearchParams()` is empty on the server of a static page: the address comes from here.
    expect(html).toContain('data-static-query="page=3"');
  });

  it("hands the rows over as fresh for the whole life of the page", async () => {
    mocks.load.mockResolvedValue({
      signature: salesSearchSignature({ page: 2 }),
      items: [{ id: "a" }],
      count: 1,
    });
    const before = Date.now();
    const html = renderToStaticMarkup(await Page(params("2")));
    const raw = /data-state="([^"]*)"/.exec(html)![1].replaceAll("&quot;", '"');
    const queries = (JSON.parse(raw) as { queries: Array<{ state: { dataUpdatedAt: number } }> })
      .queries;
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.state.dataUpdatedAt).toBeGreaterThanOrEqual(
        before + FIRST_PAGE_REVALIDATE_SECONDS * 1000,
      );
    }
  });

  describe("database outage in production", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("fails the regeneration instead of caching an empty page for 5 minutes", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PHASE", "");
      mocks.load.mockResolvedValue(null);
      await expect(Page(params("2"))).rejects.toThrow(/Catalogue public indisponible/);
    });

    it("still renders the page without a list during `next build`", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PHASE", "phase-production-build");
      mocks.load.mockResolvedValue(null);
      expect(renderToStaticMarkup(await Page(params("2")))).toContain('data-seeded="false"');
    });
  });
});
