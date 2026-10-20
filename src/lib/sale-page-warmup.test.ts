import { describe, expect, it, vi } from "vitest";
import { MAX_WARMUP_PAGES, warmSalePages } from "./sale-page-warmup";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const PRODUCTION = { SITE_URL: "https://immojudis.com", VERCEL_ENV: "production" };

function page(status = 200, cache = "MISS") {
  return new Response("<html></html>", { status, headers: { "x-vercel-cache": cache } });
}

describe("warmSalePages", () => {
  it("requests each page once on the public origin, with a short time limit", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => page());
    const log = vi.fn();

    const summary = await warmSalePages([ID, OTHER_ID, ID.toUpperCase()], {
      env: PRODUCTION,
      fetchImpl,
      log,
    });

    expect(summary).toEqual({ requested: 2, warmed: 2, failed: 0 });
    expect(fetchImpl.mock.calls.map(([url]) => url).sort()).toEqual(
      [`https://immojudis.com/sales/${ID}`, `https://immojudis.com/sales/${OTHER_ID}`].sort(),
    );
    for (const [, init] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.method).toBe("GET");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "warmed", saleId: ID }));
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: "done", requested: 2, warmed: 2 }),
    );
  });

  it("uses the production domain, never the address of the deployment", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => page());
    await warmSalePages([ID], {
      env: { ...PRODUCTION, VERCEL_URL: "immojudis-abc123.vercel.app" },
      fetchImpl,
      log: vi.fn(),
    });
    expect(fetchImpl.mock.calls[0]).toEqual([
      `https://immojudis.com/sales/${ID}`,
      expect.anything(),
    ]);
  });

  it("does nothing, and says so, when no origin is configured or the origin is invalid", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => page());
    const log = vi.fn();

    await expect(warmSalePages([ID], { env: {}, fetchImpl, log })).resolves.toMatchObject({
      skipped: "origin-not-configured",
    });
    await expect(
      warmSalePages([ID], { env: { SITE_URL: "https://immojudis.com/chemin" }, fetchImpl, log }),
    ).resolves.toMatchObject({ skipped: "origin-invalid" });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("requests nothing for an empty list", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => page());
    await expect(warmSalePages([], { env: PRODUCTION, fetchImpl, log: vi.fn() })).resolves.toEqual({
      requested: 0,
      warmed: 0,
      failed: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs a failure or a timeout and carries on with the other pages, without retrying", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith(ID)) throw new DOMException("timeout", "TimeoutError");
      return page(503);
    });
    const log = vi.fn();

    const summary = await warmSalePages([ID, OTHER_ID], { env: PRODUCTION, fetchImpl, log });

    expect(summary).toEqual({ requested: 2, warmed: 0, failed: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "failed", saleId: ID, error: "TimeoutError" }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "failed", saleId: OTHER_ID, status: 503 }),
    );
  });

  it("counts a 404 as a warmed page: the sale left the catalogue and its 404 is cached", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      page(404, "MISS"),
    );
    await expect(
      warmSalePages([ID], { env: PRODUCTION, fetchImpl, log: vi.fn() }),
    ).resolves.toMatchObject({ warmed: 1, failed: 0 });
  });

  it.each([401, 403, 429, 301, 302, 500])(
    "does not count a %i answer as a warmed page and logs its status",
    async (status) => {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
        page(status, "MISS"),
      );
      const log = vi.fn();
      const summary = await warmSalePages([ID], { env: PRODUCTION, fetchImpl, log });
      expect(summary).toEqual({ requested: 1, warmed: 0, failed: 1 });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: "failed", saleId: ID, status }),
      );
    },
  );

  it("counts every 2xx answer as a warmed page", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => page(201));
    await expect(
      warmSalePages([ID], { env: PRODUCTION, fetchImpl, log: vi.fn() }),
    ).resolves.toMatchObject({ warmed: 1, failed: 0 });
  });

  it("also warms the extra public paths, first, so that the page cap never drops them", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => page());
    const log = vi.fn();

    const summary = await warmSalePages([ID, OTHER_ID], {
      env: PRODUCTION,
      fetchImpl,
      log,
      extraPaths: ["/sales", "/sales"],
      concurrency: 1,
    });

    expect(summary).toEqual({ requested: 3, warmed: 3, failed: 0 });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://immojudis.com/sales",
      `https://immojudis.com/sales/${ID}`,
      `https://immojudis.com/sales/${OTHER_ID}`,
    ]);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: "warmed", path: "/sales", saleId: undefined }),
    );
  });

  it("keeps the extra path when a large batch is cut at the page cap", async () => {
    const ids = Array.from(
      { length: MAX_WARMUP_PAGES + 10 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => page());

    const summary = await warmSalePages(ids, {
      env: PRODUCTION,
      fetchImpl,
      log: vi.fn(),
      extraPaths: ["/sales"],
    });

    expect(summary.requested).toBe(MAX_WARMUP_PAGES);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toContain("https://immojudis.com/sales");
  });

  it("warms the extra paths even when no sale is given", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => page());
    await expect(
      warmSalePages([], { env: PRODUCTION, fetchImpl, log: vi.fn(), extraPaths: ["/sales"] }),
    ).resolves.toEqual({ requested: 1, warmed: 1, failed: 0 });
  });

  it("really gives up after the time limit", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

    const summary = await warmSalePages([ID], {
      env: PRODUCTION,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
      log: vi.fn(),
    });

    expect(summary.failed).toBe(1);
  });

  it("never has more than four pages in flight", async () => {
    const ids = Array.from(
      { length: MAX_WARMUP_PAGES + 6 },
      (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return page();
    });

    const summary = await warmSalePages(ids, { env: PRODUCTION, fetchImpl, log: vi.fn() });

    // A batch larger than the cap warms its first MAX_WARMUP_PAGES pages only.
    expect(summary).toEqual({ requested: MAX_WARMUP_PAGES, warmed: MAX_WARMUP_PAGES, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_WARMUP_PAGES);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
