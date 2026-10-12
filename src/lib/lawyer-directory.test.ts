import { describe, expect, it } from "vitest";
import {
  inferBarAssociation,
  isSponsoredLawyerPlacement,
  resolveCnbDatasetBarKey,
} from "@/lib/lawyer-directory";

describe("lawyer directory", () => {
  it("déduit le barreau depuis le tribunal de l'annonce", () => {
    expect(inferBarAssociation("Tribunal judiciaire de Bordeaux")).toBe("Bordeaux");
    expect(inferBarAssociation("TJ de Paris — saisie immobilière")).toBe("Paris");
  });

  it("n'utilise jamais la ville de la vente lorsque le tribunal ne désigne pas de siège", () => {
    expect(inferBarAssociation("Cour d'appel")).toBeNull();
    expect(inferBarAssociation(null)).toBeNull();
  });

  it("résout les barreaux dont le nom officiel diffère de la ville du tribunal", () => {
    expect(resolveCnbDatasetBarKey("Bobigny")).toBe("seine saint denis");
    expect(resolveCnbDatasetBarKey("Angoulême")).toBe("charente");
    expect(resolveCnbDatasetBarKey("Niort")).toBe("deux sevres");
  });

  it("ne sponsorise que les placements payants dans leur fenêtre de diffusion", () => {
    const now = new Date("2026-07-14T10:00:00.000Z");

    expect(
      isSponsoredLawyerPlacement(
        {
          paid_placement_status: "active",
          paid_placement_starts_at: "2026-07-01T00:00:00.000Z",
          paid_placement_ends_at: "2026-07-31T23:59:59.000Z",
        },
        now,
      ),
    ).toBe(true);
    expect(
      isSponsoredLawyerPlacement(
        {
          paid_placement_status: "not_started",
          paid_placement_starts_at: null,
          paid_placement_ends_at: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isSponsoredLawyerPlacement(
        {
          paid_placement_status: "trial",
          paid_placement_starts_at: "2026-08-01T00:00:00.000Z",
          paid_placement_ends_at: null,
        },
        now,
      ),
    ).toBe(false);
  });
});
