import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  after: vi.fn(),
  warmSalePages: vi.fn(),
}));

// `after()` only exists inside a request: the test keeps the callbacks and runs them by hand.
vi.mock("next/server", async () => ({
  ...(await vi.importActual<typeof import("next/server")>("next/server")),
  after: mocks.after,
}));
vi.mock("@/lib/sale-page-warmup", () => ({ warmSalePages: mocks.warmSalePages }));

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
import { maxDuration, POST } from "./route";

const SECRET = "cron-secret-for-tests";
const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";

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
  it("allows the warm-up run after the response enough time (24 pages x 5 s / 4 = 30 s)", () => {
    expect(maxDuration).toBe(60);
  });

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", SECRET);
    mocks.revalidateTag.mockReset();
    mocks.revalidatePath.mockReset();
    mocks.after.mockReset();
    mocks.warmSalePages.mockReset().mockResolvedValue({ requested: 0, warmed: 0, failed: 0 });
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
    expect(mocks.revalidatePath).not.toHaveBeenCalledWith("/sales");
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(2);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(2);
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
    // Two sales: two tags and two pages for them, plus the catalogue.
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(3);
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(3);
  });

  it("expires several sales once each", async () => {
    const response = await POST(request({ saleIds: [ID, OTHER_ID, ID] }, `Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      revalidated: [`sale-${ID}`, `sale-${OTHER_ID}`],
    });
    // Two sales, plus the catalogue (see below).
    expect(mocks.revalidateTag).toHaveBeenCalledWith(`sale-${ID}`, { expire: 0 });
    expect(mocks.revalidateTag).toHaveBeenCalledWith(`sale-${OTHER_ID}`, { expire: 0 });
    expect(mocks.revalidateTag).toHaveBeenCalledTimes(3);
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
    // The sale pages, plus the public `/sales` (rewritten to the static page that was just expired).
    expect(mocks.warmSalePages).toHaveBeenCalledWith([ID, OTHER_ID], {
      requestId: response.headers.get("x-request-id"),
      extraPaths: ["/sales"],
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
