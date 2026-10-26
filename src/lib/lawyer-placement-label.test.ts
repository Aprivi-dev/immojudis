import { describe, expect, it } from "vitest";
import {
  PEPITE_INDEPENDENCE_SENTENCE,
  sponsoredPlacementDisclosure,
} from "./lawyer-placement-label";

const ACTIVE =
  "Ce cabinet rémunère Immojudis pour apparaître ici. Il ne s’agit ni d’une recommandation, ni d’une notation, ni d’une garantie de résultat, et l’ordre des annonces n’en est pas modifié.";
const TRIAL =
  "Ce cabinet bénéficie actuellement d’une période d’essai gratuite de cette offre payante. Il ne s’agit ni d’une recommandation, ni d’une notation, ni d’une garantie de résultat, et l’ordre des annonces n’en est pas modifié.";

describe("mention d'un encart sponsorisé", () => {
  it("ferme les deux variantes par la phrase d'indépendance quand le repère Pépite est ouvert", () => {
    expect(PEPITE_INDEPENDENCE_SENTENCE).toBe("Cet encart est sans lien avec le repère Pépite.");
    for (const placement of ["active", "trial", null, undefined] as const) {
      const text = sponsoredPlacementDisclosure(placement, { pepites: true });
      expect(text.endsWith(PEPITE_INDEPENDENCE_SENTENCE)).toBe(true);
      expect(text).toContain("l’ordre des annonces n’en est pas modifié.");
    }
    expect(sponsoredPlacementDisclosure("active", { pepites: true })).toBe(
      `${ACTIVE} ${PEPITE_INDEPENDENCE_SENTENCE}`,
    );
    expect(sponsoredPlacementDisclosure("trial", { pepites: true })).toBe(
      `${TRIAL} ${PEPITE_INDEPENDENCE_SENTENCE}`,
    );
  });

  it("en mode shadow (repère pas ouvert), ne parle pas du repère : le texte relu, tel quel", () => {
    for (const options of [undefined, {}, { pepites: false }]) {
      expect(sponsoredPlacementDisclosure("active", options)).toBe(ACTIVE);
      expect(sponsoredPlacementDisclosure("trial", options)).toBe(TRIAL);
      expect(sponsoredPlacementDisclosure("active", options)).not.toMatch(/pépite/i);
    }
  });
});
