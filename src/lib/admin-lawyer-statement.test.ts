import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), rpc: vi.fn() }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuthContext: mocks.requireAuth,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { rpc: mocks.rpc },
}));

import { getAdminLawyerStatement } from "./admin-lawyer-statement";

const lawyerId = "c6400000-1000-4000-8000-000000000001";
const row = {
  lawyer_id: lawyerId,
  display_name: "Maître Claire Durand",
  firm_name: null,
  impressions: 12,
  cta_clicks: 3,
  referral_requests_sent: 1,
};

describe("getAdminLawyerStatement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAuth.mockResolvedValue({ userId: "admin-1", isAdmin: true });
    mocks.rpc.mockResolvedValue({ data: [row], error: null });
  });

  it("reads the month of an administrator through the SQL function", async () => {
    const statement = await getAdminLawyerStatement("token", "2026-11");

    expect(mocks.requireAuth).toHaveBeenCalledWith("token");
    expect(mocks.rpc).toHaveBeenCalledWith("admin_lawyer_monthly_statement", {
      p_month: "2026-11-01",
    });
    expect(statement.month).toBe("2026-11");
    expect(statement.totals).toEqual({ impressions: 12, ctaClicks: 3, referralRequestsSent: 1 });
  });

  it("refuses an account without the administrator role, before reading anything", async () => {
    mocks.requireAuth.mockResolvedValue({ userId: "user-1", isAdmin: false });

    await expect(getAdminLawyerStatement("token", "2026-11")).rejects.toThrow("Forbidden");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses a request without a valid session", async () => {
    mocks.requireAuth.mockRejectedValue(new Error("Unauthorized: missing bearer token"));

    await expect(getAdminLawyerStatement("", "2026-11")).rejects.toThrow("Unauthorized");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses a month outside the AAAA-MM format", async () => {
    await expect(getAdminLawyerStatement("token", "2026-11-15")).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("says that the migration is missing when the function does not exist yet", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } });

    await expect(getAdminLawyerStatement("token", "2026-11")).rejects.toThrow(
      "migration à appliquer",
    );
  });

  it("lets other database errors through", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("boom") });

    await expect(getAdminLawyerStatement("token", "2026-11")).rejects.toThrow("boom");
  });
});
