import { describe, expect, it } from "vitest";
import { riskTexts } from "@/lib/sale-risk-texts";
import type { SaleRisk } from "@/lib/types";

const risk = {
  risk_type: "urbanisme",
  risk_label: "Servitude d’alignement",
  evidence: "Arrêté du 3 mars 2020",
  evidence_json: {
    excerpt: "parcelle AB 123 frappée d’alignement",
    reasoning: "Le modèle estime un recul de 2 m",
    why_it_matters: "Constructibilité réduite",
    next_action: "Demander le certificat d’urbanisme",
  },
  occurrences: [
    {
      document_label: "Cahier des conditions de vente",
      document_type: "ccv",
      excerpt: "  section   AB  ",
      matched_terms: ["AB 123", "alignement"],
    },
  ],
} as unknown as SaleRisk;

describe("riskTexts", () => {
  it("lit par défaut le libellé, les preuves, l'explication du modèle et les extraits", () => {
    expect(riskTexts(risk)).toEqual([
      "Servitude d’alignement",
      "Arrêté du 3 mars 2020",
      "parcelle AB 123 frappée d’alignement",
      "Le modèle estime un recul de 2 m",
      "Constructibilité réduite",
      "Demander le certificat d’urbanisme",
      "Cahier des conditions de vente",
      "ccv",
      "section AB",
    ]);
  });

  it("met le code du risque en tête, s'en tient aux extraits et ajoute les termes repérés sur demande", () => {
    expect(riskTexts(risk, { withType: true, excerptsOnly: true, matchedTerms: true })).toEqual([
      "urbanisme",
      "Servitude d’alignement",
      "Arrêté du 3 mars 2020",
      "parcelle AB 123 frappée d’alignement",
      "Cahier des conditions de vente",
      "ccv",
      "section AB",
      "AB 123 alignement",
    ]);
  });
});
