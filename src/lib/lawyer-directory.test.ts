import { describe, expect, it } from "vitest";
import { inferBarAssociation, isSponsoredLawyerPlacement } from "@/lib/lawyer-directory";

describe("lawyer directory", () => {
  it("déduit le barreau depuis le tribunal de l'annonce", () => {
    expect(inferBarAssociation("Tribunal judiciaire de Bordeaux", "Pessac")).toBe("Bordeaux");
    expect(inferBarAssociation("TJ de Paris — saisie immobilière", "Clichy")).toBe("Paris");
  });

  it("utilise la ville lorsque le tribunal ne permet pas de déduire le barreau", () => {
    expect(inferBarAssociation("Cour d'appel", "Lyon")).toBe("Lyon");
    expect(inferBarAssociation(null, "Barreau de Lille")).toBe("Lille");
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
