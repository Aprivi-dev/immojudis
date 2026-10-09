import { describe, expect, it } from "vitest";
import { withdrawalInformationLines } from "./withdrawal-form";

describe("withdrawalInformationLines", () => {
  it("states the 14-day right, the proportional payment and the model form", () => {
    const text = withdrawalInformationLines({
      publisher: {
        entityName: "Immojudis SAS",
        address: "1 rue de Paris, 75001 Paris",
        contactEmail: "contact@immojudis.test",
      },
      rightsUrl: "https://immojudis.com/mes-droits",
      orderedOn: "2026-10-09T10:00:00.000Z",
    }).join("\n");
    expect(text).toContain("14 jours");
    expect(text).toContain("montant proportionnel");
    expect(text).toContain("https://immojudis.com/mes-droits");
    expect(text).toContain("À l'attention de Immojudis SAS, 1 rue de Paris, 75001 Paris");
    expect(text).toContain("Commandé le : 2026-10-09T10:00:00.000Z");
    expect(text).toContain("Nom du consommateur");
  });

  it("falls back to the legal notice when the publisher is not filled in yet", () => {
    const text = withdrawalInformationLines({
      publisher: { entityName: null, address: null, contactEmail: null },
      rightsUrl: "https://immojudis.com/mes-droits",
      orderedOn: "x",
    }).join("\n");
    expect(text).toContain("mentions légales");
    expect(text).not.toContain("null");
  });
});
