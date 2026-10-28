import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { RateLimitError } from "@/lib/api-errors";

const mocks = vi.hoisted(() => ({
  daily: vi.fn(),
  launchOffer: vi.fn(),
  confirmedEmail: vi.fn(),
  usageLimit: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ enforceDailyOperationLimits: mocks.daily }));
vi.mock("@/lib/launch-offer.server", () => ({
  // Essai en cours ou non (`confirmedEmail`), sans date de fin connue ; l'interrupteur coupé ferme
  // l'essai, comme la vraie lecture.
  hasActiveSignupTrial: mocks.confirmedEmail,
  readSignupTrial: async (userId: string) => ({
    active: Boolean((await mocks.launchOffer()) && (await mocks.confirmedEmail(userId))),
    endsAt: null,
  }),
}));
vi.mock("@/lib/sale-unlocks.server", () => ({ hasUnlockedSale: vi.fn() }));
vi.mock("@/lib/usage", () => ({
  assertUsageLimitAvailable: mocks.usageLimit,
  recordFeatureUsageEvent: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));

import { exportPropertyReportPdf, savePropertyReport } from "@/lib/property-reports";

const request = new Request("https://immojudis.com/api/property-reports", { method: "POST" });

function account({ isAdmin }: { isAdmin: boolean }) {
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  const supabaseFrom = vi.fn(() => query);
  return {
    auth: {
      userId: "user-1",
      claims: {},
      accountTier: "free",
      userRole: isAdmin ? "admin" : "user",
      isAdmin,
      hasProfile: true,
      supabase: { from: supabaseFrom },
    } as unknown as SupabaseAuthContext,
    supabaseFrom,
  };
}

const input = {
  saleId: "11111111-1111-4111-8111-111111111111",
  reportKind: "opportunity",
} as unknown as Parameters<typeof savePropertyReport>[0]["input"];

describe("plafonds journaliers des rapports enregistrés et de leur export PDF", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.launchOffer.mockResolvedValue(false);
    mocks.confirmedEmail.mockResolvedValue(true);
  });

  it("ne consomme aucun plafond pour un compte qui n'a pas le droit (création et PDF)", async () => {
    const { auth } = account({ isAdmin: false });
    await expect(savePropertyReport({ auth, input, request })).rejects.toThrow(
      "Rapports réservés à l’offre Analyse.",
    );
    await expect(exportPropertyReportPdf({ auth, reportId: "r", request })).rejects.toThrow(
      "Export PDF réservé à l’offre Analyse.",
    );
    expect(mocks.daily).not.toHaveBeenCalled();
  });

  it("applique le plafond de création avant tout appel externe ou écriture", async () => {
    const { auth, supabaseFrom } = account({ isAdmin: true });
    mocks.daily.mockRejectedValue(
      new RateLimitError(undefined, 600, "Limite quotidienne atteinte."),
    );

    await expect(savePropertyReport({ auth, input, request })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(mocks.daily).toHaveBeenCalledWith({
      request,
      userId: "user-1",
      operation: "propertyReportCreate",
      launchOffer: false,
    });
    expect(supabaseFrom).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("applique le plafond d'export PDF avant le quota mensuel et la lecture du rapport", async () => {
    const { auth, supabaseFrom } = account({ isAdmin: true });
    mocks.daily.mockRejectedValue(
      new RateLimitError(undefined, 600, "Limite quotidienne atteinte."),
    );

    await expect(exportPropertyReportPdf({ auth, reportId: "r", request })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(mocks.daily).toHaveBeenCalledWith({
      request,
      userId: "user-1",
      operation: "propertyReportPdf",
      launchOffer: false,
    });
    expect(mocks.usageLimit).not.toHaveBeenCalled();
    expect(supabaseFrom).not.toHaveBeenCalled();
  });

  it("signale les comptes de l'offre de lancement, pour qu'ils aient leur propre part du plafond global", async () => {
    mocks.launchOffer.mockResolvedValue(true);
    const { auth } = account({ isAdmin: false });
    mocks.daily.mockRejectedValue(
      new RateLimitError(undefined, 600, "Limite quotidienne atteinte."),
    );

    await expect(savePropertyReport({ auth, input, request })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    await expect(exportPropertyReportPdf({ auth, reportId: "r", request })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(mocks.daily).toHaveBeenCalledWith({
      request,
      userId: "user-1",
      operation: "propertyReportCreate",
      launchOffer: true,
    });
    expect(mocks.daily).toHaveBeenCalledWith({
      request,
      userId: "user-1",
      operation: "propertyReportPdf",
      launchOffer: true,
    });
  });
});
