import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SaleUnlockResult, SaleUnlockStatus } from "@/lib/sale-unlocks";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  enforce: vi.fn(),
  getStatus: vi.fn(),
  unlock: vi.fn(),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  bearerTokenFromRequest: vi.fn(() => "token"),
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/lib/rate-limit", () => ({ enforceUserRateLimit: mocks.enforce }));
vi.mock("@/lib/sale-unlocks.server", async () => {
  class SaleUnlockQuotaError extends Error {
    readonly status: SaleUnlockStatus;
    constructor(status: SaleUnlockStatus) {
      super("quota");
      this.status = status;
    }
  }
  return {
    SaleUnlockQuotaError,
    getSaleUnlockStatus: mocks.getStatus,
    unlockSale: mocks.unlock,
  };
});

import { PublicApiError } from "@/lib/api-errors";
import { SaleUnlockQuotaError } from "@/lib/sale-unlocks.server";
import { GET, POST } from "./route";

const saleId = "11111111-1111-4111-8111-111111111111";
const auth = { userId: "user-1" };
const status: SaleUnlockStatus = {
  saleId,
  unlocked: false,
  analysisAccess: false,
  limit: 3,
  used: 3,
  remaining: 0,
  periodStart: "2026-09-30T22:00:00.000Z",
  resetsAt: "2026-10-31T23:00:00.000Z",
};
const context = (id = saleId) => ({ params: Promise.resolve({ id }) });
const post = (id = saleId) =>
  POST(new Request(`https://example.test/api/sales/${id}/unlock`, { method: "POST" }), context(id));

describe("POST /api/sales/[id]/unlock", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.enforce.mockResolvedValue(1);
  });

  it("unlocks the sale for the signed-in account and answers privately", async () => {
    const result: SaleUnlockResult = {
      ...status,
      unlocked: true,
      used: 1,
      remaining: 2,
      alreadyUnlocked: false,
      consumed: true,
    };
    mocks.unlock.mockResolvedValue(result);

    const response = await post();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ result });
    expect(mocks.unlock).toHaveBeenCalledWith(auth, saleId);
  });

  it("requires a signed-in account before touching the quota", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    const response = await post();

    expect(response.status).toBe(401);
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("rejects an identifier that is not a UUID", async () => {
    const response = await post("not-a-uuid");

    expect(response.status).toBe(400);
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("explains an exhausted quota with the counter and the reset date (409)", async () => {
    mocks.unlock.mockRejectedValue(new SaleUnlockQuotaError(status));

    const response = await post();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Vous avez utilisé tous vos déblocages de ce mois-ci.",
      code: "unlock_quota_reached",
      status,
    });
  });

  it("answers 404 for a sale that is missing or no longer online", async () => {
    mocks.unlock.mockRejectedValue(new PublicApiError("Vente introuvable ou plus en ligne.", 404));

    const response = await post();

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Vente introuvable ou plus en ligne." });
  });
});

describe("GET /api/sales/[id]/unlock", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.requireAuth.mockResolvedValue(auth);
    mocks.enforce.mockResolvedValue(1);
  });

  it("reads the status without consuming anything", async () => {
    mocks.getStatus.mockResolvedValue({ ...status, remaining: 2, used: 1 });

    const response = await GET(
      new Request(`https://example.test/api/sales/${saleId}/unlock`),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: { ...status, remaining: 2, used: 1 } });
    expect(mocks.getStatus).toHaveBeenCalledWith(auth, saleId);
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("requires a signed-in account", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));
    const response = await GET(
      new Request(`https://example.test/api/sales/${saleId}/unlock`),
      context(),
    );
    expect(response.status).toBe(401);
  });
});

describe("unlock path and payments", () => {
  it("never reaches Stripe, billing or any promotional email", () => {
    for (const file of [
      "src/app/api/sales/[id]/unlock/route.ts",
      "src/lib/sale-unlocks.server.ts",
      "src/lib/sale-unlocks.ts",
    ]) {
      const source = readFileSync(resolve(file), "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
      expect(
        imports.filter((specifier) => /stripe|billing|resend|email|notification/i.test(specifier)),
        file,
      ).toEqual([]);
    }
  });
});
