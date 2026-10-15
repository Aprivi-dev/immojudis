import { describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import {
  getSaleUnlockStatus,
  hasUnlockedSale,
  listUnlockedSales,
  SaleUnlockQuotaError,
  unlockSale,
} from "@/lib/sale-unlocks.server";

const saleId = "11111111-1111-4111-8111-111111111111";
const rpcStatus = {
  sale_id: saleId,
  unlocked: true,
  analysis_access: false,
  limit: 3,
  used: 3,
  remaining: 0,
  period_start: "2026-09-30T22:00:00+00:00",
  period_end: "2026-10-31T23:00:00+00:00",
};

function authWith(rpc: ReturnType<typeof vi.fn>) {
  return { supabase: { rpc }, userId: "user-1" } as unknown as SupabaseAuthContext;
}

describe("sale unlock server helpers", () => {
  it("reads the status through the caller's own client", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: rpcStatus, error: null });
    const status = await getSaleUnlockStatus(authWith(rpc), saleId);
    expect(rpc).toHaveBeenCalledWith("get_sale_unlock_status", { p_sale_id: saleId });
    expect(status).toMatchObject({ unlocked: true, remaining: 0, limit: 3 });
  });

  it.each(["PGRST202", "42883"])(
    "answers « nothing to unlock » instead of an error when the function is missing (%s)",
    async (code) => {
      const rpc = vi.fn().mockResolvedValue({ data: null, error: { code, message: "not found" } });
      const status = await getSaleUnlockStatus(authWith(rpc), saleId);
      expect(status).toMatchObject({
        saleId,
        unlocked: false,
        unlockable: false,
        analysisAccess: false,
        limit: null,
        remaining: null,
      });
      expect(Date.parse(status.resetsAt)).toBeGreaterThan(Date.parse(status.periodStart));
    },
  );

  it("does not hide a real database failure behind the missing-function fallback", async () => {
    const failure = { code: "XX000", message: "boom" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: failure });
    await expect(getSaleUnlockStatus(authWith(rpc), saleId)).rejects.toBe(failure);
  });

  it("answers yes only when the database confirms the unlock", async () => {
    const yes = vi.fn().mockResolvedValue({ data: rpcStatus, error: null });
    const no = vi.fn().mockResolvedValue({ data: { ...rpcStatus, unlocked: false }, error: null });
    expect(await hasUnlockedSale(authWith(yes), saleId)).toBe(true);
    expect(await hasUnlockedSale(authWith(no), saleId)).toBe(false);
  });

  it("falls back to « no », never to « yes », when the function is not deployed yet", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });
    expect(await hasUnlockedSale(authWith(rpc), saleId)).toBe(false);
  });

  it("does not hide a real database failure behind « no »", async () => {
    const failure = { code: "XX000", message: "boom" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: failure });
    await expect(hasUnlockedSale(authWith(rpc), saleId)).rejects.toBe(failure);
  });

  it("returns what the unlock consumed", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ...rpcStatus, used: 1, remaining: 2, already_unlocked: false, consumed: true },
      error: null,
    });
    const result = await unlockSale(authWith(rpc), saleId);
    expect(rpc).toHaveBeenCalledWith("unlock_sale", { p_sale_id: saleId });
    expect(result).toMatchObject({ consumed: true, alreadyUnlocked: false, remaining: 2 });
  });

  it("reports an exhausted quota with the counter, to explain the refusal", async () => {
    const rpc = vi.fn(async (name: string) =>
      name === "unlock_sale"
        ? {
            data: null,
            error: { code: "P0001", details: "sale_unlock_quota_reached", message: "quota" },
          }
        : { data: { ...rpcStatus, unlocked: false }, error: null },
    );
    const failure = await unlockSale(authWith(rpc), saleId).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SaleUnlockQuotaError);
    expect((failure as SaleUnlockQuotaError).status).toMatchObject({ remaining: 0, limit: 3 });
  });

  it("answers 404 for a sale that is missing or no longer online", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "P0002", message: "x" } });
    const failure = await unlockSale(authWith(rpc), saleId).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PublicApiError);
    expect((failure as PublicApiError).status).toBe(404);
  });

  it("treats a missing session as an authentication failure", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "x" } });
    await expect(unlockSale(authWith(rpc), saleId)).rejects.toThrow(/^Unauthorized/);
  });
});

describe("listUnlockedSales", () => {
  function authWithView(result: { data: unknown; error: unknown }) {
    const builder = {
      select: vi.fn(),
      order: vi.fn(),
      limit: vi.fn().mockResolvedValue(result),
    };
    builder.select.mockReturnValue(builder);
    builder.order.mockReturnValue(builder);
    const from = vi.fn().mockReturnValue(builder);
    return {
      auth: { supabase: { from }, userId: "user-1" } as unknown as SupabaseAuthContext,
      from,
      builder,
    };
  }

  it("reads the unlocked-sales view of the caller, nearest sale first, with a few columns", async () => {
    const { auth, from, builder } = authWithView({
      data: [
        {
          id: saleId,
          title: "Appartement à Lyon",
          city: "Lyon",
          department: "69",
          property_type: "apartment",
          starting_price_eur: 90000,
          sale_date: "2026-11-20T09:00:00+00:00",
          status: "upcoming",
          raw_payload: { secret: true },
        },
      ],
      error: null,
    });

    const sales = await listUnlockedSales(auth);

    expect(from).toHaveBeenCalledWith("v_auction_sales_unlocked");
    expect(builder.select).toHaveBeenCalledWith(
      "id,title,city,department,property_type,starting_price_eur,sale_date,status",
    );
    expect(builder.order).toHaveBeenNthCalledWith(1, "sale_date", {
      ascending: true,
      nullsFirst: false,
    });
    expect(sales).toEqual([
      {
        id: saleId,
        title: "Appartement à Lyon",
        city: "Lyon",
        department: "69",
        propertyType: "apartment",
        startingPriceEur: 90000,
        saleDate: "2026-11-20T09:00:00+00:00",
        status: "upcoming",
      },
    ]);
  });

  it.each(["42P01", "PGRST205"])(
    "answers an empty list when the view is not deployed (%s)",
    async (code) => {
      const { auth } = authWithView({ data: null, error: { code, message: "missing" } });
      expect(await listUnlockedSales(auth)).toEqual([]);
    },
  );

  it("does not hide a real database failure behind an empty list", async () => {
    const failure = { code: "XX000", message: "boom" };
    const { auth } = authWithView({ data: null, error: failure });
    await expect(listUnlockedSales(auth)).rejects.toBe(failure);
  });
});
