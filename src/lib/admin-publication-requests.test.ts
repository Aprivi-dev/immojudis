import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicApiError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), from: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import {
  adminPublicationQuerySchema,
  assertPublicationDateIsPublishable,
  listAdminPublicationRequests,
  reviewAdminPublicationRequest,
} from "./admin-publication-requests";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

/** Requête simulée : chaque méthode renvoie la requête, l'attente rend `result`. */
function query(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "or", "order", "range", "maybeSingle"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return builder;
}

describe("admin publication date validation", () => {
  it("compares the civil date in Paris and accepts an audience today", () => {
    vi.useFakeTimers();
    // 22:30 UTC is already the next civil day in Paris during October.
    vi.setSystemTime(new Date("2026-10-03T22:30:00.000Z"));

    expect(assertPublicationDateIsPublishable("2026-10-04")).toBe("2026-10-04");
    expect(() => assertPublicationDateIsPublishable("2026-10-03")).toThrow(
      "date de vente est passée",
    );
  });

  it("refuses a missing, malformed or past date as a business refusal (422)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
    for (const value of [null, "03/10/2026", "2026-02-30", "2026-10-02"]) {
      let failure: unknown;
      try {
        assertPublicationDateIsPublishable(value);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(PublicApiError);
      expect((failure as PublicApiError).status).toBe(422);
    }
  });
});

describe("admin publication requests list", () => {
  it("keeps 30 requests per page by default, within the common admin bounds", () => {
    expect(adminPublicationQuerySchema.parse({})).toMatchObject({ offset: 0, limit: 30 });
    expect(() => adminPublicationQuerySchema.parse({ limit: 101 })).toThrow();
    expect(() => adminPublicationQuerySchema.parse({ offset: 100_001 })).toThrow();
  });

  it("answers the common admin page meta: total, offset, limit, hasMore", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: "admin" });
    mocks.from
      .mockReturnValueOnce(query({ data: [{ id: REQUEST_ID }], error: null, count: 31 }))
      .mockReturnValueOnce(query({ count: 4, error: null }));

    const page = await listAdminPublicationRequests({
      authToken: "token",
      input: adminPublicationQuerySchema.parse({}),
    });

    expect(page).toEqual({
      requests: [{ id: REQUEST_ID }],
      pendingCount: 4,
      offset: 0,
      limit: 30,
      total: 31,
      hasMore: true,
    });
  });
});

describe("admin publication review", () => {
  it("refuses to reject a request already linked to a published sale (409)", async () => {
    mocks.requireAuth.mockResolvedValue({ isAdmin: true, userId: "admin" });
    mocks.from.mockReturnValue(
      query({ data: { id: REQUEST_ID, published_sale_id: "sale-1" }, error: null }),
    );

    const failure = await reviewAdminPublicationRequest({
      authToken: "token",
      input: { id: REQUEST_ID, status: "rejected" },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PublicApiError);
    expect(failure).toMatchObject({ status: 409 });
  });
});
