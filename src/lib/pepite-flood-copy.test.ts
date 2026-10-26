import { describe, expect, it } from "vitest";
import * as copy from "./pepite-flood-copy";
import { PEPITE_CRITERION_LABELS, floodPassAdminLabel } from "./pepite-reasons";
import { pepiteFloodView } from "./sale-pepite-view";

/** Tous les textes du contrôle d'inondation, tels que le public ou l'administration les lit. */
function allFloodTexts(): string[] {
  const constants = (Object.values(copy) as unknown[]).filter(
    (value): value is string => typeof value === "string",
  );
  const verdicts = [
    { verdict: "none_found" },
    { verdict: "none_found", ppriChecked: false },
    { verdict: "exposed" },
    { verdict: "no_signal" },
    { verdict: "unknown" },
  ].flatMap((flood) => {
    const view = pepiteFloodView({
      flood: { ...flood, observedAt: "2026-11-05T09:00:00.000Z", mapDate: "2013-12-18" },
    });
    return view ? [view.line, view.details ?? "", view.sourceLine ?? "", view.warning] : [];
  });
  const adminLabels = [
    floodPassAdminLabel({ verdict: "none_found", ppriChecked: true }),
    floodPassAdminLabel({ verdict: "none_found", ppriChecked: false }),
    floodPassAdminLabel({ verdict: "exposed" }),
    floodPassAdminLabel({ verdict: "no_signal" }),
    floodPassAdminLabel(null),
  ];
  return [
    ...constants,
    ...verdicts,
    ...adminLabels,
    copy.floodTriSourceLine("5 novembre 2026"),
    copy.floodPm1SourceLine("5 novembre 2026"),
    PEPITE_CRITERION_LABELS.no_high_flood_risk.pass,
    PEPITE_CRITERION_LABELS.no_high_flood_risk.fail,
    PEPITE_CRITERION_LABELS.flood_risk_known.pass,
    PEPITE_CRITERION_LABELS.flood_risk_known.fail,
  ];
}

describe("textes du contrôle d'inondation", () => {
  it("n'emploient aucun mot interdit (« hors zone inondable », « sans risque », « sécurisé », « certifié »…)", () => {
    const texts = allFloodTexts();
    expect(texts.length).toBeGreaterThan(15);
    for (const text of texts) {
      for (const forbidden of copy.FLOOD_FORBIDDEN_WORDS) {
        expect(text, `« ${text} » contient ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("refusent bien les mots interdits (le contrôle de mots n'est pas vide)", () => {
    for (const bad of [
      "Bien hors zone inondable",
      "Zone non inondable",
      "Un bien sans risque",
      "Logement sécurisé",
      "Aucun risque d’inondation",
      "Bien certifié",
      "Crue de dix ans",
    ]) {
      expect(
        copy.FLOOD_FORBIDDEN_WORDS.some((pattern) => pattern.test(bad)),
        bad,
      ).toBe(true);
    }
    // La tournure validée n'est pas refusée.
    expect(
      copy.FLOOD_FORBIDDEN_WORDS.some((pattern) => pattern.test(copy.FLOOD_NONE_FOUND_LINE)),
    ).toBe(false);
  });

  it("parlent de crue fréquente, jamais d'une durée de retour chiffrée", () => {
    const joined = allFloodTexts().join(" ");
    expect(joined).toMatch(/crue fréquente/);
    expect(joined).not.toMatch(/\b(?:dix|10) ans\b/i);
  });

  it("ne promettent jamais l'absence de risque, et renvoient à l'état des risques", () => {
    expect(copy.FLOOD_WARNING).toMatch(/ne garantit pas l’absence de risque/);
    expect(copy.FLOOD_WARNING).toMatch(/état des risques/);
    expect(copy.FLOOD_NONE_FOUND_DETAIL).toMatch(/Ce n’est pas une garantie d’absence de risque/);
    expect(copy.FLOOD_NO_SIGNAL_LINE).toMatch(/ne dit rien du risque propre au bien/);
  });

  it("le texte « exposé » reste neutre : zonage à vérifier, sans couleur de zone affirmée", () => {
    expect(copy.FLOOD_EXPOSED_SHORT).toBe(
      "Dans le périmètre d’un plan de prévention des risques d’inondation (PPRi) : zonage à vérifier.",
    );
    expect(copy.FLOOD_EXPOSED_LONG).toMatch(/ne dit pas dans quelle zone du plan/);
  });
});
