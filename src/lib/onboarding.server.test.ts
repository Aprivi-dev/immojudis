import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicSaleLookup } from "@/lib/public-sale.server";
import { onboardingAreaForSale } from "./onboarding.server";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/public-sale.server", () => ({ lookupPublicSale: lookup }));

const SALE = "4655881c-249d-4eab-beba-f2624d8a1af0";

function found(department: string | null): PublicSaleLookup {
  return { status: "found", sale: { id: SALE, department } as never };
}

afterEach(() => {
  lookup.mockReset();
});

describe("secteur prérempli de la première recherche (inscription depuis une fiche)", () => {
  it.each([
    ["33", "33"],
    ["2a", "2A"],
    ["974", "974"],
    ["Gironde", "33"],
  ])("prend le département de la vente (%s)", async (department, area) => {
    lookup.mockResolvedValue(found(department));
    await expect(onboardingAreaForSale(`/sales/${SALE}?from=%2Ffavoris`)).resolves.toBe(area);
    expect(lookup).toHaveBeenCalledWith(SALE);
  });

  it("ne lit rien sans fiche d'origine", async () => {
    await expect(onboardingAreaForSale(undefined)).resolves.toBe("");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    ["vente absente", () => lookup.mockResolvedValue({ status: "missing" })],
    ["base non configurée", () => lookup.mockResolvedValue({ status: "unavailable" })],
    ["base en erreur", () => lookup.mockRejectedValue(new Error("timeout"))],
    ["sans département", () => lookup.mockResolvedValue(found(null))],
    ["département inconnu", () => lookup.mockResolvedValue(found("99"))],
  ])("laisse le secteur vide : %s", async (_case, arrange) => {
    arrange();
    await expect(onboardingAreaForSale(`/sales/${SALE}`)).resolves.toBe("");
  });
});
