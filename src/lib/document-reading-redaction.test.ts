import { describe, expect, it } from "vitest";
import { mapDocumentReading } from "./document-reading";
import { redactReadingTexts } from "./document-reading-redaction";

const reading = (points: unknown[]) =>
  redactReadingTexts(mapDocumentReading({ status: "completed", points }));

describe("redactReadingTexts", () => {
  it("replaces the names of private individuals in the title, the explanation and the quote", () => {
    const result = reading([
      {
        theme: "occupation",
        importance: "alerte",
        title: "Bien occupé par Monsieur Jean DUPONT",
        explanation: "Le bien est occupé par Madame Sophie MARTIN depuis 2019.",
        quote: "Le bien est occupé par Monsieur Jean DUPONT suivant bail du 3 mars 2021.",
        page: 4,
      },
      {
        theme: "juridique",
        importance: "info",
        title: "Poursuivant",
        quote:
          "À la requête de Madame Sophie MARTIN, née le 12/03/1970 à Lyon, demeurant 4 rue des Lilas à Pau",
        page: 1,
      },
    ]);

    expect(result.points).toHaveLength(2);
    expect(result.points[0].title).toBe("Bien occupé par un occupant");
    expect(result.points[0].explanation).toBe("Le bien est occupé par un occupant depuis 2019.");
    expect(result.points[0].quote).toBe(
      "Le bien est occupé par un occupant suivant bail du 3 mars 2021.",
    );
    expect(result.points[1].quote).toBe("À la requête du créancier poursuivant");
    expect(JSON.stringify(result)).not.toMatch(/DUPONT|MARTIN|Sophie|Jean/);
  });

  it("keeps professional contacts, places and amounts untouched, and a missing explanation null", () => {
    const result = reading([
      {
        theme: "conditions_vente",
        importance: "info",
        title: "Avocat poursuivant",
        quote: "Me Durand, avocat, demeurant 5 rue de la Paix à Bordeaux, mise à prix 80 000 euros",
        page: 1,
      },
    ]);
    expect(result.points[0].quote).toBe(
      "Me Durand, avocat, demeurant 5 rue de la Paix à Bordeaux, mise à prix 80 000 euros",
    );
    expect(result.points[0].explanation).toBeNull();
  });

  it("leaves the rest of the reading as it was", () => {
    const result = reading([]);
    expect(result).toMatchObject({ access: "full", status: "completed", points: [] });
  });
});
