import { describe, expect, it } from "vitest";
import {
  coproDistressKinds,
  coproDistressKindsInText,
  hasCoproDistress,
  type CoproReadingPoint,
} from "./pepite-copro";

const point = (overrides: Partial<CoproReadingPoint> = {}): CoproReadingPoint => ({
  theme: "copropriete",
  title: "Copropriété",
  explanation: null,
  quote: "Le syndicat des copropriétaires est à jour de ses charges.",
  ...overrides,
});

describe("copropriété en difficulté : mentions explicites dans les pièces lues", () => {
  it("reconnaît un administrateur provisoire", () => {
    expect(
      hasCoproDistress([
        point({ quote: "La copropriété est placée sous administrateur provisoire." }),
      ]),
    ).toBe(true);
    expect(coproDistressKindsInText("Un Administrateur Provisoire a été désigné")).toEqual([
      "administrateur_provisoire",
    ]);
  });

  it("reconnaît un plan de sauvegarde", () => {
    expect(
      coproDistressKindsInText("Un plan de sauvegarde de la copropriété est en cours"),
    ).toEqual(["plan_de_sauvegarde"]);
  });

  it("reconnaît un mandataire ad hoc, avec ou sans trait d'union", () => {
    expect(coproDistressKindsInText("désignation d'un mandataire ad hoc")).toEqual([
      "mandataire_ad_hoc",
    ]);
    expect(coproDistressKindsInText("désignation d'un mandataire ad-hoc")).toEqual([
      "mandataire_ad_hoc",
    ]);
  });

  it("reconnaît une carence, sans tenir compte de la casse ni des accents", () => {
    expect(coproDistressKindsInText("La copropriété est en état de carence")).toEqual(["carence"]);
    expect(coproDistressKindsInText("CARENCE de la copropriété")).toEqual(["carence"]);
    expect(coproDistressKindsInText("Carence")).toEqual(["carence"]);
  });

  it("ne tient pas « carence d'enchères » pour une difficulté de copropriété", () => {
    for (const text of [
      "carence d'enchères",
      "carence d’enchères",
      "Carence d'Enchères",
      "carence d'enchère",
      "carence d encheres",
      "procès-verbal de carence d’enchères",
    ]) {
      expect(coproDistressKindsInText(text), text).toEqual([]);
    }
    expect(
      hasCoproDistress([point({ quote: "Aucune enchère : carence d’enchères constatée." })]),
    ).toBe(false);
  });

  it("garde la carence quand elle est mentionnée en plus d'une carence d'enchères", () => {
    expect(
      coproDistressKindsInText("carence d’enchères au premier tour ; copropriété en carence"),
    ).toEqual(["carence"]);
  });

  it("ne reconnaît rien d'autre : ni « absence de syndic », ni syndic bénévole, ni procédure ordinaire", () => {
    for (const text of [
      "Absence de syndic",
      "La copropriété n'a pas de syndic professionnel",
      "syndic bénévole",
      "administrateur judiciaire",
      "plan de financement des travaux",
      "mandataire judiciaire",
      "procédure de sauvegarde de la société venderesse",
      "Charges impayées de 3 200 euros",
    ]) {
      expect(coproDistressKindsInText(text), text).toEqual([]);
    }
  });

  it("ne lit que le thème copropriété", () => {
    const text = "administrateur provisoire, plan de sauvegarde, mandataire ad hoc, carence";
    for (const theme of [
      "occupation",
      "etat_travaux",
      "juridique",
      "autre",
      "conditions_vente",
    ] as const) {
      expect(hasCoproDistress([point({ theme, quote: text })]), theme).toBe(false);
    }
    expect(coproDistressKinds([point({ quote: text })]).sort()).toEqual([
      "administrateur_provisoire",
      "carence",
      "mandataire_ad_hoc",
      "plan_de_sauvegarde",
    ]);
  });

  it("lit le titre, l'explication et la citation", () => {
    expect(hasCoproDistress([point({ title: "Plan de sauvegarde en cours" })])).toBe(true);
    expect(hasCoproDistress([point({ explanation: "Un mandataire ad hoc est nommé." })])).toBe(
      true,
    );
  });

  it("n'a rien à dire sans lecture ni point", () => {
    expect(hasCoproDistress(null)).toBe(false);
    expect(hasCoproDistress(undefined)).toBe(false);
    expect(hasCoproDistress([])).toBe(false);
    expect(coproDistressKinds([])).toEqual([]);
  });
});
