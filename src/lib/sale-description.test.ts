import { describe, expect, it } from "vitest";
import {
  buildStructuredDescription,
  getSaleAiDescription,
  getSaleDisplayDescription,
  hasSaleAiDescription,
} from "./sale-description";
import type { AuctionSale } from "./types";

function sale(overrides: Partial<AuctionSale>): AuctionSale {
  return overrides as AuctionSale;
}

describe("sale AI display description", () => {
  it("uses the LLM display description when available", () => {
    const item = sale({
      llm_display_description: "Synthèse IA prête.",
      about_description: "Description brute héritée.",
      source_description: "Texte source brut.",
      description: "Description collectée brute.",
    });

    expect(getSaleAiDescription(item)).toBe("Synthèse IA prête.");
    expect(getSaleDisplayDescription(item)).toBe("Synthèse IA prête.");
    expect(hasSaleAiDescription(item)).toBe(true);
  });

  it("falls back to the about description when the LLM display description is missing", () => {
    const item = sale({
      llm_display_description: null,
      about_description: "Description synthétique disponible.",
      source_description: "Texte source brut.",
      description: "Description collectée brute.",
    });

    expect(getSaleAiDescription(item)).toBeNull();
    expect(getSaleDisplayDescription(item)).toBe("Description synthétique disponible.");
    expect(hasSaleAiDescription(item)).toBe(false);
  });

  it("uses source descriptions before generating a structured fallback", () => {
    const item = sale({
      llm_display_description: null,
      about_description: null,
      source_description: "Texte source exploitable.",
      description: "Description collectée brute.",
    });

    expect(getSaleDisplayDescription(item)).toBe("Texte source exploitable.");
  });

  it("generates a factual fallback instead of showing a pending message", () => {
    const item = sale({
      llm_display_description: null,
      about_description: null,
      source_description: null,
      description: null,
      city: "Bordeaux",
      department: "33",
      tribunal_name: "TJ Bordeaux",
      property_type: "apartment",
      starting_price_eur: 92_000,
      sale_date: "2026-10-15T09:30:00+02:00",
      app_surface_m2: 42.6,
      rooms_count: 2,
      occupancy_status: "unknown",
    });

    expect(getSaleDisplayDescription(item)).toContain("Ce bien situé à Bordeaux, 33");
    expect(getSaleDisplayDescription(item)).toContain("92");
    expect(getSaleDisplayDescription(item)).not.toContain("Synthèse IA en cours");
  });

  it("does not append an absent occupation fallback to the generated description", () => {
    const text = buildStructuredDescription(
      sale({
        property_type: "apartment",
        rooms_count: 2,
        occupancy_status: "unknown",
      }),
    );

    expect(text).toContain("2 pièces");
    expect(text).not.toContain("Non renseignée");
    expect(text).not.toContain("À confirmer");
  });

  it("does not invent a judicial hearing for notarial or unknown sales", () => {
    const result = getSaleDisplayDescription(
      sale({ sale_venue_type: "notary", sale_date: null, starting_price_eur: null }),
    );
    expect(result).toContain("Vente notariale");
    expect(result).toContain("La date de vente reste à confirmer");
    expect(result).not.toContain("audience");
    expect(result).not.toContain("vente judiciaire");
    expect(result).not.toContain("le Date à confirmer");
  });
});

describe("structured sale status", () => {
  it.each(["cancelled", "canceled", "postponed"])(
    "does not confirm a stored appointment for %s",
    (status) => {
      const text = buildStructuredDescription(
        sale({ status, sale_date: "2026-10-15T09:30:00+02:00" }),
        new Date("2026-09-10T10:00:00Z"),
      );
      expect(text).not.toContain("La vente est prévue");
      expect(text).not.toContain("est proposé à la vente");
      expect(text).toContain(status === "postponed" ? "Vente reportée" : "Vente annulée");
      expect(text).toContain("ne vaut pas rendez-vous confirmé");
    },
  );
  it("identifies a past date without inferring an adjudication", () => {
    const text = buildStructuredDescription(
      sale({ sale_date: "2026-09-07T12:00:00Z" }),
      new Date("2026-09-10T10:00:00Z"),
    );
    expect(text).toContain("Date de vente passée · résultat à confirmer");
    expect(text).toContain("Date annoncée dans le dossier");
    expect(text).not.toContain("La vente est prévue");
  });
  it("preserves the upcoming date for an active sale", () => {
    const text = buildStructuredDescription(
      sale({ sale_date: "2026-10-15T09:30:00+02:00" }),
      new Date("2026-09-10T10:00:00Z"),
    );
    expect(text).toContain("La vente est prévue le 15 octobre 2026");
  });
  it("names the tribunal with its article, never 'auprès de Tribunal judiciaire'", () => {
    const text = buildStructuredDescription(
      sale({
        sale_venue_type: "tribunal",
        tribunal_name: "Tribunal judiciaire de Bordeaux",
        sale_date: "2026-10-15T09:30:00+02:00",
      }),
      new Date("2026-09-10T10:00:00Z"),
    );
    expect(text).toContain(
      "La vente est prévue le 15 octobre 2026 au tribunal judiciaire de Bordeaux.",
    );
    expect(text).not.toMatch(/auprès de Tribunal/i);
  });
});

it("does not call the inherited surface of a commercial building habitable", () => {
  const text = buildStructuredDescription(
    sale({
      property_type: "commercial",
      habitable_surface_m2: 1335,
      source_description: "Bâtiment d’une surface totale de 1 335 m².",
    }),
  );
  expect(text).toContain("surface renseignée");
  expect(text).not.toContain("surface habitable");
});

describe("description construite à partir des faits (sans synthèse rédigée par le modèle)", () => {
  const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  it("dit les pièces et chambres, le terrain, les équipements, le DPE et les visites annoncées", () => {
    const text = buildStructuredDescription(
      sale({
        city: "Pau",
        department: "64",
        property_type: "house",
        status: "upcoming",
        sale_date: future,
        starting_price_eur: 120_000,
        app_surface_m2: 95,
        land_surface_m2: 400,
        rooms_count: 4,
        bedrooms_count: 3,
        has_garden: true,
        has_garage: true,
        source_blocks: { dpe: "D" },
        visit_dates: ["12/12/2099 à 14h00"],
      }),
    );
    expect(text).toContain("4 pièces dont 3 chambres");
    expect(text).toContain("terrain de 400 m²");
    expect(text).toContain("Équipements mentionnés : jardin, garage.");
    expect(text).toContain("Diagnostic de performance énergétique : classe D.");
    expect(text).toContain("Visites annoncées : ");
  });

  it("ne répète pas le terrain quand il est déjà la surface retenue, et ne dit rien de ce que l'annonce tait", () => {
    const text = buildStructuredDescription(
      sale({
        city: "Pau",
        property_type: "land",
        status: "upcoming",
        sale_date: future,
        land_surface_m2: 800,
      }),
    );
    expect(text.match(/terrain/g)).toHaveLength(1);
    const withRetainedSurface = buildStructuredDescription(
      sale({
        city: "Pau",
        property_type: "land",
        status: "upcoming",
        sale_date: future,
        app_surface_m2: 800,
        land_surface_m2: 800,
      }),
    );
    expect(withRetainedSurface).not.toContain("terrain de 800");
    expect(text).not.toContain("Équipements mentionnés");
    expect(text).not.toContain("Diagnostic de performance énergétique");
    expect(text).not.toContain("Visites annoncées");
  });

  it("n'annonce pas de visite pour une vente passée ou retirée", () => {
    const text = buildStructuredDescription(
      sale({
        city: "Pau",
        status: "cancelled",
        sale_date: future,
        visit_dates: ["12/12/2099 à 14h00"],
      }),
    );
    expect(text).not.toContain("Visites annoncées");
  });
});
