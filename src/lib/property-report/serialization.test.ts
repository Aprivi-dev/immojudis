import { describe, expect, it } from "vitest";
import type { AppSaleRow } from "@/lib/property-reports";
import { rentabilityLabel } from "@/lib/profitability";
import {
  appSaleRowToAuctionSale,
  formatReportPercent,
  normalizeEvidence,
  opportunityScoreLabel,
} from "./serialization";

describe("opportunityScoreLabel", () => {
  it("reprend les paliers et les mots neutres du score de rentabilité (P5, J1)", () => {
    for (const score of [100, 80, 79, 65, 64, 50, 49, 0]) {
      expect(opportunityScoreLabel(score)).toBe(rentabilityLabel(score));
    }
    expect(opportunityScoreLabel(70)).toBe("Score moyen (hypothèses à confirmer)");
    expect(opportunityScoreLabel(null)).toBe("À compléter");
  });
});

describe("appSaleRowToAuctionSale", () => {
  it("retire le nom des particuliers des textes qui entrent dans un rapport partagé", () => {
    const row = {
      id: "sale-1",
      city: "Lyon",
      description: "Appartement occupé par Monsieur Pierre DUPONT suivant bail.",
      source_description:
        "À la requête de Monsieur Henri FAURE, demeurant 14 rue des Lilas 69003 Lyon.",
      source_blocks: { detail: { Occupation: "Locataire Madame Sara LOPEZ" } },
      source_blocks_by_source: { "source:1": { Occupation: "occupé par Madame Eva ROY" } },
      risks: [
        {
          risk_type: "occupancy",
          risk_label: "Locataire en place",
          severity: 2,
          evidence: "bail consenti à Monsieur Olivier MOREAU",
        },
      ],
    } as unknown as AppSaleRow;

    const sale = appSaleRowToAuctionSale(row);

    expect(sale.city).toBe("Lyon");
    expect(sale.description).toBe("Appartement occupé par un occupant suivant bail.");
    expect(sale.source_description).toBe("À la requête du créancier poursuivant.");
    expect(sale.source_blocks).toEqual({ detail: { Occupation: "Locataire" } });
    expect(sale.source_blocks_by_source).toEqual({
      "source:1": { Occupation: "occupé par un occupant" },
    });
    expect(sale.risks?.[0].evidence).toBe("bail consenti à un locataire");
    expect(JSON.stringify(sale)).not.toMatch(/DUPONT|FAURE|LOPEZ|MOREAU|ROY/);
  });

  it("laisse une fiche sans nom de particulier telle quelle", () => {
    const row = {
      id: "sale-2",
      description: "Occupé, locataire en place. Local commercial occupé par la SARL Dupont Frères.",
      risks: [],
    } as unknown as AppSaleRow;

    expect(appSaleRowToAuctionSale(row).description).toBe(row.description);
  });
});

describe("normalizeEvidence", () => {
  it("écrit chaque pièce « libellé | source | extrait », sans case vide, huit au plus", () => {
    const items = [
      { label: "Bail", source: "Cahier des conditions", excerpt: "loué depuis 2019" },
      { label: "DPE", source: "", excerpt: "classe E" },
      { label: "", source: "", excerpt: "" },
      "texte libre",
      ...Array.from({ length: 10 }, (_, index) => ({ label: `Pièce ${index}` })),
    ];

    const lines = normalizeEvidence(items);

    expect(lines[0]).toBe("Bail | Cahier des conditions | loué depuis 2019");
    expect(lines[1]).toBe("DPE | classe E");
    expect(lines[2]).toBe("Pièce 0");
    expect(lines).toHaveLength(8);
    expect(normalizeEvidence(null)).toEqual([]);
  });
});

describe("formatReportPercent", () => {
  it("écrit un pourcentage de 0 à 100 avec une décimale au plus, « — » s'il manque", () => {
    expect(formatReportPercent(12.34)).toBe("12,3 %");
    expect(formatReportPercent(8)).toBe("8 %");
    expect(formatReportPercent(null)).toBe("—");
    expect(formatReportPercent("12")).toBe("—");
  });
});
