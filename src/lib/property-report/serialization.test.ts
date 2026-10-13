import { describe, expect, it } from "vitest";
import type { AppSaleRow } from "@/lib/property-reports";
import { appSaleRowToAuctionSale } from "./serialization";

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
    expect(sale.description).toBe("Appartement occupé par un locataire suivant bail.");
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
