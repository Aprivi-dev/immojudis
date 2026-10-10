import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  // The data cache is replaced by a pass-through in unit tests.
  unstable_cache: (load: (...args: unknown[]) => unknown) => load,
}));

import { isDefaultCatalogueSearch, loadInitialCatalogue } from "./public-catalogue.server";
import { salesSearchSignature } from "./search/search-url-state";

const page = (ids: string[], count = ids.length) => ({
  items: ids.map((id) => ({ id })) as never[],
  count,
});

describe("initial catalogue rendered on the server", () => {
  const search = vi.fn();
  const firstPage = vi.fn();

  beforeEach(() => {
    search.mockReset();
    firstPage.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("serves the unfiltered first page from the shared cache", async () => {
    firstPage.mockResolvedValue(page(["a", "b"], 2276));
    const result = await loadInitialCatalogue({}, { search, firstPage });
    expect(result).toEqual({
      signature: "[]",
      items: [{ id: "a" }, { id: "b" }],
      count: 2276,
    });
    expect(firstPage).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
  });

  it("does not cache filtered searches: each one reads the database", async () => {
    search.mockResolvedValue(page(["c"]));
    const filters = { city: "Pau" };
    const result = await loadInitialCatalogue(filters, { search, firstPage });
    expect(search).toHaveBeenCalledWith(filters);
    expect(firstPage).not.toHaveBeenCalled();
    expect(result?.signature).toBe(salesSearchSignature(filters));
  });

  it("treats page 1 and the default sort as the unfiltered catalogue", () => {
    expect(isDefaultCatalogueSearch({ page: 1, sort: "relevance" })).toBe(true);
    expect(isDefaultCatalogueSearch({ page: 2 })).toBe(false);
    expect(isDefaultCatalogueSearch({ limit: 12 })).toBe(false);
  });

  it("never lists the demonstration sales", async () => {
    firstPage.mockResolvedValue(page(["example-immojudis-bordeaux-t2", "real"]));
    const result = await loadInitialCatalogue({}, { search, firstPage });
    expect(result?.items.map((sale) => sale.id)).toEqual(["real"]);
  });

  it("falls back to the browser when the database fails", async () => {
    search.mockRejectedValue(new Error("statement timeout"));
    expect(await loadInitialCatalogue({ city: "Pau" }, { search, firstPage })).toBeNull();
  });

  it("falls back to the browser when the database is too slow", async () => {
    search.mockReturnValue(new Promise(() => undefined));
    expect(
      await loadInitialCatalogue({ city: "Pau" }, { search, firstPage, timeoutMs: 5 }),
    ).toBeNull();
  });

  it("leaves oversized pages to the browser instead of failing the render", async () => {
    expect(await loadInitialCatalogue({ limit: 500 }, { search, firstPage })).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });
});
