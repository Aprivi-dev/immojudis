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

import Page, { metadata } from "./page";
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

  it("has an accented title and description, without the site name", () => {
    expect(metadata.title).toBe("Ventes immobilières aux enchères : tribunal, notaire, État");
    expect(String(metadata.description)).toMatch(/^Consultez les ventes immobilières aux enchères/);
    expect(String(metadata.title)).not.toMatch(/immojudis/i);
    expect(metadata.alternates).toEqual({ canonical: "/sales" });
  });
});
