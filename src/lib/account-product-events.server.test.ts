import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { accountProductEventRow, recordAccountProductEvent } from "./account-product-events.server";

const userId = "7d335032-e935-4550-9347-ed22b0f63449";
const saleId = "A1B2C3D4-0000-4000-8000-000000000001";

describe("recordAccountProductEvent", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValue({ data: true, error: null });
  });

  it("records a sale event for the account with the sale and nothing else", async () => {
    await expect(
      recordAccountProductEvent(userId, { type: "sale_unlocked", saleId }),
    ).resolves.toBe(true);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("record_account_product_event", {
      p_user_id: userId,
      p_event_type: "sale_unlocked",
      p_sale_id: "a1b2c3d4-0000-4000-8000-000000000001",
    });
  });

  it("records a quota with its closed detail and no sale", async () => {
    await recordAccountProductEvent(userId, { type: "quota_reached", quota: "favorites" });

    expect(mocks.rpc).toHaveBeenCalledWith("record_account_product_event", {
      p_user_id: userId,
      p_event_type: "quota_reached",
      p_detail: "favorites",
    });
  });

  it.each(["daily_account", "daily_shared"] as const)(
    "records the %s cap as a quota with its closed detail",
    async (quota) => {
      await recordAccountProductEvent(userId, { type: "quota_reached", quota });
      expect(mocks.rpc).toHaveBeenCalledWith("record_account_product_event", {
        p_user_id: userId,
        p_event_type: "quota_reached",
        p_detail: quota,
      });
    },
  );

  it("records an email click with the kind of email and the sale", async () => {
    await recordAccountProductEvent(userId, { type: "email_clicked", email: "reminder", saleId });

    expect(mocks.rpc).toHaveBeenCalledWith("record_account_product_event", {
      p_user_id: userId,
      p_event_type: "email_clicked",
      p_detail: "reminder",
      p_sale_id: "a1b2c3d4-0000-4000-8000-000000000001",
    });
  });

  it.each([null, undefined, "", "user-1", "not-a-uuid"])(
    "records nothing without a valid account (%s)",
    async (account) => {
      await expect(
        recordAccountProductEvent(account as string | null | undefined, {
          type: "calendar_exported",
          saleId,
        }),
      ).resolves.toBe(false);
      expect(mocks.rpc).not.toHaveBeenCalled();
    },
  );

  it("records nothing for a sale that is not an identifier", async () => {
    await expect(
      recordAccountProductEvent(userId, { type: "bid_ceiling_calculated", saleId: "sale-1" }),
    ).resolves.toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers false when the event of the day already exists", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    await expect(
      recordAccountProductEvent(userId, { type: "calendar_exported", saleId }),
    ).resolves.toBe(false);
  });

  it("never throws: a database error is logged without any content and swallowed", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom", code: "XX000" } });
    await expect(
      recordAccountProductEvent(userId, { type: "quota_reached", quota: "daily" }),
    ).resolves.toBe(false);

    mocks.rpc.mockRejectedValue(new Error("network down"));
    await expect(
      recordAccountProductEvent(userId, { type: "quota_reached", quota: "daily" }),
    ).resolves.toBe(false);

    const logged = vi
      .mocked(console.warn)
      .mock.calls.map(([line]) => String(line))
      .join("\n");
    expect(logged).toContain("account-product-events");
    expect(logged).not.toContain(userId);
  });
});

describe("closed list of quota details in the database", () => {
  it("accepts every quota the code can record (migration 20261029120100)", () => {
    const sql = readFileSync(
      "supabase/migrations/20261029120100_account_product_events_daily_detail.sql",
      "utf8",
    ).replace(/^\s*--.*$/gm, "");
    for (const quota of ["unlocks", "favorites", "daily", "daily_account", "daily_shared"]) {
      expect(sql).toContain(`'${quota}'`);
    }
  });
});

describe("accountProductEventRow", () => {
  it("maps every event to the columns of the table, with no free field", () => {
    expect(accountProductEventRow({ type: "sale_unlocked", saleId })).toEqual({
      eventType: "sale_unlocked",
      detail: null,
      saleId: "a1b2c3d4-0000-4000-8000-000000000001",
    });
    expect(accountProductEventRow({ type: "quota_reached", quota: "unlocks" })).toEqual({
      eventType: "quota_reached",
      detail: "unlocks",
      saleId: null,
    });
    expect(
      Object.keys(
        accountProductEventRow({ type: "email_clicked", email: "alert", saleId })!,
      ).sort(),
    ).toEqual(["detail", "eventType", "saleId"]);
  });

  it("records the weekly digest and sale result clicks under their own detail", () => {
    for (const email of ["weekly", "result"] as const) {
      expect(accountProductEventRow({ type: "email_clicked", email, saleId })).toMatchObject({
        eventType: "email_clicked",
        detail: email,
      });
    }
  });

  it("refuses an event type outside the closed list", () => {
    expect(accountProductEventRow({ type: "page_viewed" } as never)).toBeNull();
  });
});
