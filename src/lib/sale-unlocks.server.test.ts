import { describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { PublicApiError } from "@/lib/api-errors";
import {
  getSaleUnlockStatus,
  hasUnlockedSale,
  listUnlockedSales,
  redeemSaleUnlockCredit,
  SaleUnlockQuotaError,
  unlockSale,
} from "@/lib/sale-unlocks.server";

const saleId = "11111111-1111-4111-8111-111111111111";
const rpcStatus = {
  sale_id: saleId,
  unlocked: true,
  analysis_access: false,
  limit: 1,
  used: 1,
  remaining: 0,
};

function authWith(rpc: ReturnType<typeof vi.fn>) {
  return { supabase: { rpc }, userId: "user-1" } as unknown as SupabaseAuthContext;
}

describe("sale unlock server helpers", () => {
  it("reads the status through the caller's own client", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: rpcStatus, error: null });
    const status = await getSaleUnlockStatus(authWith(rpc), saleId);
    expect(rpc).toHaveBeenCalledWith("get_sale_unlock_status", { p_sale_id: saleId });
    expect(status).toMatchObject({ unlocked: true, remaining: 0, limit: 1 });
  });

  it.each(["PGRST202", "42883"])(
    "raises a missing function (%s) instead of answering « nothing to unlock »",
    async (code) => {
      const failure = { code, message: "not found" };
      const rpc = vi.fn().mockResolvedValue({ data: null, error: failure });
      await expect(getSaleUnlockStatus(authWith(rpc), saleId)).rejects.toBe(failure);
    },
  );

  it("does not hide a real database failure", async () => {
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

  it("raises a missing function instead of answering « no » (or « yes »)", async () => {
    const failure = { code: "PGRST202", message: "not found" };
    const rpc = vi.fn().mockResolvedValue({ data: null, error: failure });
    await expect(hasUnlockedSale(authWith(rpc), saleId)).rejects.toBe(failure);
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
    expect((failure as SaleUnlockQuotaError).status).toMatchObject({ remaining: 0, limit: 1 });
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
    "raises a missing view (%s) instead of an empty list",
    async (code) => {
      const failure = { code, message: "missing" };
      const { auth } = authWithView({ data: null, error: failure });
      await expect(listUnlockedSales(auth)).rejects.toBe(failure);
    },
  );

  it("does not hide a real database failure behind an empty list", async () => {
    const failure = { code: "XX000", message: "boom" };
    const { auth } = authWithView({ data: null, error: failure });
    await expect(listUnlockedSales(auth)).rejects.toBe(failure);
  });
});

describe("unit purchase credits and unlock source", () => {
  it("reads the source of the unlock, and leaves it out when the database does not send it", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { ...rpcStatus, source: "purchase" }, error: null });
    expect(await getSaleUnlockStatus(authWith(rpc), saleId)).toMatchObject({ source: "purchase" });

    const legacy = vi.fn().mockResolvedValue({ data: rpcStatus, error: null });
    expect(await getSaleUnlockStatus(authWith(legacy), saleId)).not.toHaveProperty("source");

    const unknown = vi
      .fn()
      .mockResolvedValue({ data: { ...rpcStatus, source: "gift" }, error: null });
    expect(await getSaleUnlockStatus(authWith(unknown), saleId)).not.toHaveProperty("source");
  });

  it("redeems a credit through the caller's own client and returns the credits left", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { ...rpcStatus, credits: 0, already_unlocked: false, consumed: true },
      error: null,
    });

    const result = await redeemSaleUnlockCredit(authWith(rpc), saleId);

    expect(rpc).toHaveBeenCalledWith("redeem_sale_unlock_credit", { p_sale_id: saleId });
    expect(result).toMatchObject({ unlocked: true, consumed: true, credits: 0 });
  });

  it("reports a missing credit like an exhausted quota, with the state of the account", async () => {
    const rpc = vi.fn(async (name: string) =>
      name === "redeem_sale_unlock_credit"
        ? { data: null, error: { code: "P0001", details: "sale_unlock_no_credit", message: "x" } }
        : { data: { ...rpcStatus, unlocked: false, credits: 0 }, error: null },
    );

    const error = await redeemSaleUnlockCredit(authWith(rpc), saleId).catch((caught) => caught);

    expect(error).toBeInstanceOf(SaleUnlockQuotaError);
    expect((error as SaleUnlockQuotaError).status.credits).toBe(0);
  });

  it("answers 404 when the credit cannot open a sale that is no longer online", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "P0002", message: "Vente introuvable ou plus en ligne." },
    });

    await expect(redeemSaleUnlockCredit(authWith(rpc), saleId)).rejects.toBeInstanceOf(
      PublicApiError,
    );
  });
});
