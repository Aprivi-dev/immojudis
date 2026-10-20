import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  after: vi.fn(),
  warmSalePages: vi.fn(),
  tribunalRows: vi.fn(),
}));

// `after()` only exists inside a request: the test keeps the callbacks and runs them by hand.
vi.mock("next/server", async () => ({
  ...(await vi.importActual<typeof import("next/server")>("next/server")),
  after: mocks.after,
}));
vi.mock("@/lib/sale-page-warmup", async () => ({
  ...(await vi.importActual<typeof import("@/lib/sale-page-warmup")>("@/lib/sale-page-warmup")),
  warmSalePages: mocks.warmSalePages,
}));
// Lecture du tribunal des ventes (clé de service) : `from("auction_sales").select(…).in("id", ids)`.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (columns: string) => ({
        in: (column: string, values: string[]) =>
          mocks.tribunalRows(table, columns, column, values),
      }),
    }),
  },
}));

vi.mock("next/cache", () => ({
  revalidateTag: mocks.revalidateTag,
  revalidatePath: mocks.revalidatePath,
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, cache: <T extends (...args: never[]) => unknown>(fn: T) => fn };
});

import { PUBLIC_CATALOGUE_CACHE_TAG } from "@/lib/public-catalogue.server";
import { PUBLIC_TRIBUNAL_ACTIVITY_CACHE_TAG } from "@/lib/public-tribunal-activity.server";
import { TRIBUNAL_SALES_CACHE_TAG } from "@/lib/tribunal-pages.server";
import { HEARINGS_CACHE_TAG } from "@/lib/upcoming-hearings.server";
import { MAX_WARMUP_PAGES } from "@/lib/sale-page-warmup";
import { maxDuration, POST } from "./route";

const SECRET = "cron-secret-for-tests";
const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
/** Pages de ventes que le plafond laisse après les pages fixes et les pages tribunal (12). */
const MAX_SALES_PER_CALL_WARMED = 20;

function request(body: unknown, authorization?: string, raw = false) {
  return new Request("https://example.test/api/pipeline/revalidate-sale", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

describe("POST /api/pipeline/revalidate-sale", () => {
  it("allows the warm-up run after the response enough time (32 pages x 5 s / 4 = 40 s)", () => {
    expect(maxDuration).toBe(60);
    expect((MAX_WARMUP_PAGES * 5_000) / 4 + 20_000).toBeLessThanOrEqual(maxDuration * 1_000);
  });

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.revalidateTag.mockReset();
    mocks.revalidatePath.mockReset();
    mocks.after.mockReset();
    mocks.warmSalePages.mockReset().mockResolvedValue({ requested: 0, warmed: 0, failed: 0 });
    mocks.tribunalRows.mockReset().mockResolvedValue({ data: [], error: null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a request without the secret", async () => {
    const response = await POST(request({ saleId: ID }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret", async () => {
    const response = await POST(request({ saleId: ID }, "Bearer not-the-secret"));
    expect(response.status).toBe(401);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses every request when no secret is configured (fails closed)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const response = await POST(request({ saleId: ID }, "Bearer "));
    expect(response.status).toBe(401);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });

  it("expires the tag and the page of one sale", async () => {
    const response = await POST(request({ saleId: ID.toUpperCase() }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ ok: true, revalidated: [`sale-${ID}`] });
    expect(mocks.revalidateTag).toHaveBeenCalledWith(`sale-${ID}`, { expire: 0 });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/sales/${ID}`);
  });

  it("also expires the catalogue: its data-cache tag and the page behind the rewrite of /sales", async () => {
    const response = await POST(request({ saleId: ID }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(mocks.revalidateTag).toHaveBeenCalledWith(PUBLIC_CATALOGUE_CACHE_TAG, { expire: 0 });
    // The destination of the rewrite: the proxy does not run for revalidations, and a path that
    // matches no route file would expire nothing.
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/sales/defaut");
    // Pages 2 et 3 du catalogue : leurs variantes statiques sont expirées avec la première.
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/sales/defaut/[page]", "page");
    expect(mocks.revalidatePath).not.toHaveBeenCalledWith("/sales");
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(5);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(6);
  });

  it("also expires the tribunal pages and the upcoming hearings, once per call", async () => {
    const response = await POST(request({ saleIds: [ID, OTHER_ID] }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(TRIBUNAL_SALES_CACHE_TAG).toBe("tribunal-pages");
    expect(HEARINGS_CACHE_TAG).toBe("upcoming-hearings");
    for (const tag of [TRIBUNAL_SALES_CACHE_TAG, HEARINGS_CACHE_TAG]) {
      expect(mocks.revalidateTag.mock.calls.filter(([name]) => name === tag)).toEqual([
        [tag, { expire: 0 }],
      ]);
    }
    // Route dynamique : le motif avec le type « page », comme pour les variantes du catalogue.
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/tribunaux/[slug]", "page");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/audiences-a-venir");
  });

  it("also expires the court activity (data cache) and the court directory, once per call", async () => {
    const response = await POST(request({ saleIds: [ID, OTHER_ID] }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(PUBLIC_TRIBUNAL_ACTIVITY_CACHE_TAG).toBe("public-tribunal-activity");
    expect(
      mocks.revalidateTag.mock.calls.filter(([name]) => name === "public-tribunal-activity"),
    ).toEqual([["public-tribunal-activity", { expire: 0 }]]);
    expect(mocks.revalidatePath.mock.calls.filter(([path]) => path === "/tribunaux")).toEqual([
      ["/tribunaux"],
    ]);
  });

  it("expires the catalogue once per call, however many sales are withdrawn or changed", async () => {
    const response = await POST(request({ saleIds: [ID, OTHER_ID, ID] }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    const catalogueTags = mocks.revalidateTag.mock.calls.filter(
      ([tag]) => tag === PUBLIC_CATALOGUE_CACHE_TAG,
    );
    expect(catalogueTags).toEqual([[PUBLIC_CATALOGUE_CACHE_TAG, { expire: 0 }]]);
    const defaultPages = mocks.revalidatePath.mock.calls.filter(
      ([path]) => path === "/sales/defaut",
    );
    expect(defaultPages).toHaveLength(1);
    // Two sales: two tags and two pages for them, plus the catalogue (first page and page variants),
    // the tribunal pages and the hearings, the court activity and the court directory.
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(6);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(7);
  });

  it("expires several sales once each", async () => {
    const response = await POST(request({ saleIds: [ID, OTHER_ID, ID] }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revalidated: [`sale-${ID}`, `sale-${OTHER_ID}`],
    });
    // Two sales, plus the catalogue, the tribunal pages, the hearings and the court activity.
    expect(mocks.revalidateTag).toHaveBeenCalledWith(`sale-${ID}`, { expire: 0 });
    expect(mocks.revalidateTag).toHaveBeenCalledWith(`sale-${OTHER_ID}`, { expire: 0 });
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(6);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/sales/${OTHER_ID}`);
  });

  it("schedules one warm-up of the invalidated pages after the response, without running it", async () => {
    const response = await POST(
      request({ saleIds: [ID, OTHER_ID, ID.toUpperCase()] }, `Bearer ${SECRET}`),
    );
    expect(response.status).toBe(200);
    // Scheduled, not awaited: the response does not wait for any request to the site.
    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.warmSalePages).not.toHaveBeenCalled();

    const [callback] = mocks.after.mock.calls[0] as [() => unknown];
    await callback();

    expect(mocks.warmSalePages).toHaveBeenCalledTimes(1);
    // The sale pages, then the public `/sales` and its static pages 2 and 3 (rewritten to the variants
    // that were just expired), the upcoming hearings and the tribunal pages (here none: no row read).
    expect(mocks.warmSalePages).toHaveBeenCalledWith([ID, OTHER_ID], {
      requestId: response.headers.get("x-request-id"),
      extraPaths: ["/sales", "/sales?page=2", "/sales?page=3", "/audiences-a-venir"],
    });
  });

  it("warms the tribunal page of each sale concerned, read with the service key in the same after()", async () => {
    mocks.tribunalRows.mockResolvedValue({
      data: [
        { tribunal_code: "justice_tj_1_93" },
        { tribunal_code: "justice_tj_2_33" },
        { tribunal_code: "justice_tj_1_93" },
        { tribunal_code: null },
        { tribunal_code: "  " },
      ],
      error: null,
    });

    const response = await POST(request({ saleIds: [ID, OTHER_ID] }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    // Nothing is read before the response: the lookup belongs to the deferred work.
    expect(mocks.tribunalRows).not.toHaveBeenCalled();

    const [callback] = mocks.after.mock.calls[0] as [() => unknown];
    await callback();

    expect(mocks.tribunalRows).toHaveBeenCalledWith("auction_sales", "tribunal_code", "id", [
      ID,
      OTHER_ID,
    ]);
    expect(mocks.warmSalePages).toHaveBeenCalledWith([ID, OTHER_ID], {
      requestId: response.headers.get("x-request-id"),
      extraPaths: [
        "/sales",
        "/sales?page=2",
        "/sales?page=3",
        "/audiences-a-venir",
        "/tribunaux/justice-tj-1-93",
        "/tribunaux/justice-tj-2-33",
      ],
    });
  });

  it("warms at most eight tribunal pages, so the sale pages keep room under the page cap", async () => {
    mocks.tribunalRows.mockResolvedValue({
      data: Array.from({ length: 20 }, (_, index) => ({
        tribunal_code: `justice_tj_${String(index).padStart(2, "0")}_33`,
      })),
      error: null,
    });

    await POST(request({ saleIds: [ID] }, `Bearer ${SECRET}`));
    const [callback] = mocks.after.mock.calls[0] as [() => unknown];
    await callback();

    const { extraPaths } = mocks.warmSalePages.mock.calls[0][1] as { extraPaths: string[] };
    expect(extraPaths.filter((path) => path.startsWith("/tribunaux/"))).toHaveLength(8);
    // 4 fixed pages + 8 tribunal pages, and the sale pages of a full batch still fit.
    expect(extraPaths).toHaveLength(12);
    expect(extraPaths.length + MAX_SALES_PER_CALL_WARMED).toBeLessThanOrEqual(MAX_WARMUP_PAGES);
  });

  it("still warms the other pages when the tribunal lookup fails, and never throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.tribunalRows.mockResolvedValue({ data: null, error: { message: "boom" } });

    const response = await POST(request({ saleIds: [ID] }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    const [callback] = mocks.after.mock.calls[0] as [() => unknown];
    await expect(Promise.resolve(callback())).resolves.not.toThrow();

    expect(mocks.warmSalePages).toHaveBeenCalledWith([ID], {
      requestId: response.headers.get("x-request-id"),
      extraPaths: ["/sales", "/sales?page=2", "/sales?page=3", "/audiences-a-venir"],
    });
  });

  it.each([
    ["an empty object", {}],
    ["a malformed identifier", { saleId: "not-a-uuid" }],
    ["an empty list", { saleIds: [] }],
    ["a path traversal attempt", { saleId: `${ID}/../../admin` }],
    ["unexpected fields", { saleId: ID, path: "/admin" }],
    ["too many sales", { saleIds: Array.from({ length: 101 }, () => ID) }],
  ])("rejects %s with 400 and invalidates nothing", async (_label, body) => {
    const response = await POST(request(body, `Bearer ${SECRET}`));
    expect(response.status).toBe(400);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const response = await POST(request("{nope", `Bearer ${SECRET}`, true));
    expect(response.status).toBe(400);
    expect(mocks.revalidateTag).not.toHaveBeenCalled();
  });
});
