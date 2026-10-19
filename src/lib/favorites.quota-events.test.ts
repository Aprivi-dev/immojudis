import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ record: vi.fn(), plan: vi.fn(), insertResult: vi.fn() }));
vi.mock("@/lib/account-product-events.server", () => ({
  recordAccountProductEvent: mocks.record,
}));
vi.mock("@/lib/property-reports", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));

import { addFavoriteSale, isFavoriteQuotaError } from "./favorites";

const saleId = "7d335032-e935-4550-9347-ed22b0f63449";
const auth = {
  userId: "user-1",
  supabase: {
    from: () => ({
      insert: () => ({ select: () => ({ maybeSingle: mocks.insertResult }) }),
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    }),
  },
} as never;

const quotaError = {
  code: "P0001",
  message: "Quota de 10 favoris gratuits atteint. Retirez un favori pour en ajouter un autre.",
};

describe("favorites quota measure", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.plan.mockResolvedValue({
      plan: "decouverte",
      label: "Découverte",
      limits: { favoriteSales: 10 },
    });
    mocks.record.mockResolvedValue(true);
  });

  it("recognises the error of the quota trigger and nothing else", () => {
    expect(isFavoriteQuotaError(quotaError)).toBe(true);
    expect(
      isFavoriteQuotaError({ code: "P0001", message: "Quota de 3 favoris gratuits atteint." }),
    ).toBe(true);
    expect(isFavoriteQuotaError({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isFavoriteQuotaError({ code: "P0001", message: "Favorite owner is required." })).toBe(
      false,
    );
    expect(isFavoriteQuotaError(null)).toBe(false);
    expect(isFavoriteQuotaError("Quota de 10 favoris")).toBe(false);
  });

  it("records the quota reached for the account, then still raises the error", async () => {
    mocks.insertResult.mockResolvedValue({ data: null, error: quotaError });

    await expect(addFavoriteSale({ auth, input: { saleId } })).rejects.toBe(quotaError);

    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledWith("user-1", {
      type: "quota_reached",
      quota: "favorites",
    });
  });

  it("records nothing for another database error", async () => {
    const other = { code: "XX000", message: "boom" };
    mocks.insertResult.mockResolvedValue({ data: null, error: other });

    await expect(addFavoriteSale({ auth, input: { saleId } })).rejects.toBe(other);

    expect(mocks.record).not.toHaveBeenCalled();
  });
});
