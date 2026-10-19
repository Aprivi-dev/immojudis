import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));

vi.mock("@/lib/public-catalogue.server", () => ({ loadInitialCatalogue: mocks.load }));
vi.mock("./sales-page", () => ({
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
    // Records the dehydrated state instead of rendering the client boundary.
    HydrationBoundary: ({ state, children }: { state: unknown; children: React.ReactNode }) => (
      <div data-state={JSON.stringify(state)}>{children}</div>
    ),
  };
});

import Page, { generateMetadata } from "./page";
import { salesSearchCountQueryKey, salesSearchQueryKey } from "@/lib/search/catalog-placeholder";

function hydratedQueries(html: string) {
  const raw = /data-state="([^"]*)"/.exec(html)![1].replaceAll("&quot;", '"');
  return (JSON.parse(raw) as { queries: Array<{ queryKey: unknown[]; state: { data: unknown } }> })
    .queries;
}

describe("/sales server page", () => {
  beforeEach(() => mocks.load.mockReset());

  it("hands the first page to the browser under the keys the catalogue reads", async () => {
    mocks.load.mockResolvedValue({
      signature: "[]",
      items: [{ id: "a" }, { id: "b" }],
      count: 2276,
    });
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    const queries = hydratedQueries(html);
    expect(queries).toHaveLength(2);
    const byKey = new Map(
      queries.map((query) => [JSON.stringify(query.queryKey), query.state.data]),
    );
    expect(byKey.get(JSON.stringify(salesSearchQueryKey("[]", "anonymous:preview")))).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
    expect(byKey.get(JSON.stringify(salesSearchCountQueryKey("[]", "anonymous:preview")))).toBe(
      2276,
    );
    expect(html).toContain('data-seeded="true"');
    expect(html).toContain("<h1>Ventes immobilières aux enchères</h1>");
  });

  it("keeps the rows fresh from the moment of the render (a page built on demand is not cached)", async () => {
    mocks.load.mockResolvedValue({ signature: "[]", items: [{ id: "a" }], count: 1 });
    const before = Date.now();
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    const raw = /data-state="([^"]*)"/.exec(html)![1].replaceAll("&quot;", '"');
    const updatedAt = (JSON.parse(raw) as { queries: Array<{ state: { dataUpdatedAt: number } }> })
      .queries[0].state.dataUpdatedAt;
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(Date.now());
  });

  it("reads the filters of the URL on the server", async () => {
    mocks.load.mockResolvedValue(null);
    await Page({
      searchParams: Promise.resolve({ city: "Pau", maxPrice: "100000", q: ["a", "Pau"] }),
    });
    expect(mocks.load).toHaveBeenCalledWith(
      expect.objectContaining({ city: "Pau", maxPrice: 100000, query: "Pau" }),
    );
  });

  it("still renders when the database is unavailable: the browser takes over", async () => {
    mocks.load.mockResolvedValue(null);
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(hydratedQueries(html)).toHaveLength(0);
    expect(html).toContain('data-seeded="false"');
  });

  it("keeps that fallback in production too: only the static variant refuses an empty page", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      mocks.load.mockResolvedValue(null);
      const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
      expect(html).toContain('data-seeded="false"');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("metadata", () => {
    const metadataFor = (params: Record<string, string | string[] | undefined> = {}) =>
      generateMetadata({ searchParams: Promise.resolve(params) });

    it("has an accented title and description, without the site name", async () => {
      const metadata = await metadataFor();
      expect(metadata.title).toBe("Ventes immobilières aux enchères en France");
      expect(String(metadata.description)).toMatch(
        /^Consultez les ventes immobilières aux enchères/,
      );
      expect(String(metadata.title)).not.toMatch(/immojudis/i);
      expect(metadata.alternates).toEqual({ canonical: "/sales" });
    });

    it("keeps the canonical /sales for the first page and for every filtered address", async () => {
      for (const params of [
        {},
        { page: "1" },
        { city: "Pau" },
        { city: "Pau", page: "2" },
        { sort: "price_asc", page: "3" },
        { minPrice: "50000", page: "2" },
        { limit: "50", page: "2" },
      ]) {
        const metadata = await metadataFor(params);
        expect(metadata.alternates, JSON.stringify(params)).toEqual({ canonical: "/sales" });
        expect(metadata.title).toBe("Ventes immobilières aux enchères en France");
      }
    });

    it("gives page 2 and beyond of the unfiltered catalogue their own canonical and title", async () => {
      for (const page of ["2", "3", "10", "417"]) {
        const metadata = await metadataFor({ page });
        expect(metadata.alternates).toEqual({ canonical: `/sales?page=${page}` });
        expect(metadata.title).toEqual({
          absolute: `Ventes immobilières aux enchères en France - page ${page}`,
        });
        expect(metadata.openGraph).toMatchObject({ url: `/sales?page=${page}` });
        expect(String(metadata.description)).toContain(`Page ${page}.`);
      }
    });

    it("keeps the title within 60 characters, as the other pages", async () => {
      const metadata = await metadataFor({ page: "417" });
      expect((metadata.title as { absolute: string }).absolute.length).toBeLessThanOrEqual(60);
    });

    it("ignores a page the search cannot serve, a view choice and tracking parameters", async () => {
      // Beyond the last reachable page (offset above 10 000): nothing to index under that address.
      expect((await metadataFor({ page: "418" })).alternates).toEqual({ canonical: "/sales" });
      expect((await metadataFor({ page: "0" })).alternates).toEqual({ canonical: "/sales" });
      expect((await metadataFor({ page: "abc" })).alternates).toEqual({ canonical: "/sales" });
      // The results view and the tracking parameters are not filters of the catalogue.
      expect((await metadataFor({ page: "2", view: "table" })).alternates).toEqual({
        canonical: "/sales?page=2",
      });
      expect((await metadataFor({ page: "2", utm_source: "x" })).alternates).toEqual({
        canonical: "/sales?page=2",
      });
    });
  });
});
