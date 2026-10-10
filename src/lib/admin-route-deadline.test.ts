import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_ROUTE_MAX_DURATION_SECONDS,
  ADMIN_ROUTE_TIMEOUT_MS,
  ADMIN_TIMEOUT_CODE,
  AdminRouteTimeoutError,
  adminDeadlineSignal,
  throwIfAdminDeadlineExceeded,
  withAdminDeadline,
} from "@/lib/admin-route-deadline";

const neverResolves = () => new Promise<Response>(() => {});

describe("withAdminDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the application deadline under the platform limit and at most 30 s", () => {
    expect(ADMIN_ROUTE_MAX_DURATION_SECONDS).toBe(30);
    expect(ADMIN_ROUTE_TIMEOUT_MS).toBeLessThan(ADMIN_ROUTE_MAX_DURATION_SECONDS * 1000);
    expect(ADMIN_ROUTE_TIMEOUT_MS).toBeGreaterThan(20_000);
  });

  it("returns the handler response when it finishes in time", async () => {
    const handler = withAdminDeadline(async () => Response.json({ ok: true }));
    const response = await handler(new Request("https://example.test/api/admin/x"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers a clear 504 with a request id when a read exceeds the deadline", async () => {
    const handler = withAdminDeadline(neverResolves);
    const pending = handler(
      new Request("https://example.test/api/admin/dashboard", {
        headers: { "x-request-id": "req-timeout-0001" },
      }),
    );
    await vi.advanceTimersByTimeAsync(ADMIN_ROUTE_TIMEOUT_MS);
    const response = await pending;
    expect(response.status).toBe(504);
    expect(response.headers.get("x-request-id")).toBe("req-timeout-0001");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.code).toBe(ADMIN_TIMEOUT_CODE);
    expect(body.requestId).toBe("req-timeout-0001");
    expect(body.error).toContain("30 secondes");
    expect(body.error).toContain("Réessayez");
  });

  it("warns that a write may have succeeded after a timeout", async () => {
    const handler = withAdminDeadline(neverResolves);
    const pending = handler(
      new Request("https://example.test/api/admin/scroll", { method: "POST" }),
    );
    await vi.advanceTimersByTimeAsync(ADMIN_ROUTE_TIMEOUT_MS);
    const response = await pending;
    expect(response.status).toBe(504);
    expect((await response.json()).error).toContain("a pu aboutir");
  });

  it("does not answer 504 one millisecond before the deadline", async () => {
    let resolveHandler: (response: Response) => void = () => {};
    const handler = withAdminDeadline(
      () => new Promise<Response>((resolve) => (resolveHandler = resolve)),
    );
    const pending = handler(new Request("https://example.test/api/admin/x"));
    await vi.advanceTimersByTimeAsync(ADMIN_ROUTE_TIMEOUT_MS - 1);
    resolveHandler(Response.json({ late: false }));
    expect((await pending).status).toBe(200);
  });

  it("aborts the signal seen by the handler so long loops stop working", async () => {
    let seen: AbortSignal | undefined;
    let loopStopped = false;
    const handler = withAdminDeadline(async () => {
      seen = adminDeadlineSignal();
      try {
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          throwIfAdminDeadlineExceeded();
        }
      } catch (error) {
        loopStopped = error instanceof AdminRouteTimeoutError;
        throw error;
      }
    });
    const pending = handler(new Request("https://example.test/api/admin/x"));
    await vi.advanceTimersByTimeAsync(ADMIN_ROUTE_TIMEOUT_MS + 2_000);
    expect((await pending).status).toBe(504);
    expect(seen?.aborted).toBe(true);
    expect(loopStopped).toBe(true);
  });

  it("supports a custom shorter deadline and forwards extra arguments", async () => {
    const handler = withAdminDeadline(
      async (_request: Request, context: { params: Promise<{ id: string }> }) =>
        Response.json({ id: (await context.params).id }),
      { timeoutMs: 1_000 },
    );
    const response = await handler(new Request("https://example.test/api/admin/x/1"), {
      params: Promise.resolve({ id: "abc" }),
    });
    expect(await response.json()).toEqual({ id: "abc" });
  });

  it("exposes no deadline outside an admin route", () => {
    expect(adminDeadlineSignal()).toBeUndefined();
    expect(() => throwIfAdminDeadlineExceeded()).not.toThrow();
  });
});

describe("routes /api/admin", () => {
  const adminRoutes = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return adminRoutes(path);
      return name === "route.ts" ? [path] : [];
    });
  const files = adminRoutes(join(process.cwd(), "src/app/api/admin"));

  it("finds the admin routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
  });

  it.each(files.map((file) => [relative(process.cwd(), file), file]))(
    "%s fixes a 30 s maxDuration and wraps every handler",
    (_name, file) => {
      const source = readFileSync(file, "utf8");
      expect(source).toMatch(/export const maxDuration = 30;/);
      expect(source).not.toMatch(/export (async )?function (GET|POST|PATCH|PUT|DELETE)\b/);
      const exported = [...source.matchAll(/export const (GET|POST|PATCH|PUT|DELETE) = (\w+)\(/g)];
      expect(exported.length).toBeGreaterThan(0);
      for (const [, , wrapper] of exported) expect(wrapper).toBe("withAdminDeadline");
    },
  );
});
