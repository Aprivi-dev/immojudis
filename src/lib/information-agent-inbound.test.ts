import { describe, expect, it, vi } from "vitest";
import {
  extractInformationAgentFacts,
  findInboundToken,
  htmlToPlainText,
  normalizeEmail,
  replyTextForExtraction,
} from "@/lib/information-agent-inbound";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), storage: { from: vi.fn() } },
}));

describe("information agent inbound parsing", () => {
  it("routes only the signed case address on the configured domain", () => {
    const token = "11111111-1111-4111-8111-111111111111";
    expect(
      findInboundToken(
        [`Assistant ImmoJudis <enquete+${token}@reponses.immojudis.com>`],
        "reponses.immojudis.com",
      ),
    ).toBe(token);
    expect(
      findInboundToken([`enquete+${token}@example.test`], "reponses.immojudis.com"),
    ).toBeNull();
    expect(
      findInboundToken([`enquete+${token}@reponsesXimmojudis.com`], "reponses.immojudis.com"),
    ).toBeNull();
    expect(
      findInboundToken(
        [
          `enquete+${token}@reponses.immojudis.com`,
          "enquete+22222222-2222-4222-8222-222222222222@reponses.immojudis.com",
        ],
        "reponses.immojudis.com",
      ),
    ).toBeNull();
  });

  it("uses only the addr-spec in a From header", () => {
    expect(normalizeEmail("Contact <contact@example.test>")).toBe("contact@example.test");
    expect(normalizeEmail("contact@example.test <attacker@example.test>")).toBe(
      "attacker@example.test",
    );
    expect(normalizeEmail("Contact contact@example.test")).toBe("");
    expect(normalizeEmail("contact@example.test, attacker@example.test")).toBe("");
    expect(normalizeEmail("contact@example.test, Attacker <attacker@example.test>")).toBe("");
  });

  it("does not extract claims from quoted older messages", () => {
    expect(
      replyTextForExtraction(
        "Bonjour, je vérifie.\n\nLe 20 septembre, ImmoJudis a écrit :\n> Surface 84 m² et 4 pièces",
      ),
    ).toBe("Bonjour, je vérifie.");
  });

  it("extracts text with a parser and ignores active HTML content", () => {
    const text = htmlToPlainText(
      "<style>body{display:none}</style><script >alert('&amp;')</script ><p>Surface &amp; état</p><p>84 m²</p>",
    );

    expect(text).toBe("Surface & état\n\n84 m²");
    expect(htmlToPlainText("<p>Je vérifie.</p><blockquote>Surface 84 m²</blockquote>")).toBe(
      "Je vérifie.",
    );
  });

  it("extracts bounded candidates without treating them as verified facts", () => {
    const facts = extractInformationAgentFacts(
      "Le logement est libre. La surface habitable est de 84,5 m² et il comprend 4 pièces.",
    );

    expect(facts.map((fact) => fact.factKey)).toEqual([
      "surface_m2",
      "rooms_count",
      "occupancy_status",
    ]);
    expect(facts[0]?.proposedValue).toEqual({ value: 84.5, unit: "m2" });
    expect(facts[1]?.proposedValue).toEqual({ value: 4 });
    expect(facts[2]?.proposedValue).toEqual({ value: "vacant" });
  });

  it("rejects implausible numeric candidates", () => {
    expect(extractInformationAgentFacts("Surface annoncée : 9999999 m² et 999 pièces.")).toEqual(
      [],
    );
  });

  it("keeps contradictory values out of automatic candidate extraction", () => {
    const facts = extractInformationAgentFacts(
      "La surface était 80 m², finalement 84 m². L'ancien plan comptait 3 pièces, le nouveau 4 pièces. Le bien était libre mais le logement est loué.",
    );
    expect(facts).toEqual([]);
  });

  it("recognizes accented French occupancy words", () => {
    expect(extractInformationAgentFacts("Le bien est loué.")).toMatchObject([
      { factKey: "occupancy_status", proposedValue: { value: "rented" } },
    ]);
    expect(extractInformationAgentFacts("La maison est occupée.")).toMatchObject([
      { factKey: "occupancy_status", proposedValue: { value: "occupied" } },
    ]);
    expect(extractInformationAgentFacts("Le logement est squatté.")).toMatchObject([
      { factKey: "occupancy_status", proposedValue: { value: "squatted" } },
    ]);
  });

  it("extracts explicitly labelled sale dates and starting prices", () => {
    const facts = extractInformationAgentFacts(
      "La date de la vente est fixée au 14 septembre 2026 à 9 h. Mise à prix : 120 000 €.",
    );

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factKey: "sale_date",
          proposedValue: { value: "2026-09-14" },
          displayValue: "14/09/2026",
          confidence: 0.94,
        }),
        expect.objectContaining({
          factKey: "starting_price_eur",
          proposedValue: { value: 120000, unit: "EUR" },
          displayValue: "120 000 €",
          confidence: 0.95,
        }),
      ]),
    );
  });

  it("supports ISO dates and compact thousand or kilo price notation", () => {
    expect(
      extractInformationAgentFacts(
        "Date de l'adjudication : 2026-10-03. Prix de départ : 95 k€.",
      ).map((fact) => fact.proposedValue),
    ).toEqual([{ value: "2026-10-03" }, { value: 95000, unit: "EUR" }]);
  });

  it("rejects uncertain, contradictory and invalid labelled values", () => {
    const extracted = extractInformationAgentFacts(
      "Date de vente à confirmer : 14/09/2026. Date d'adjudication : 15/09/2026. Mise à prix non communiquée : 120 000 €.",
    );
    expect(extracted).toEqual([]);
    expect(extractInformationAgentFacts("Date de la vente : 31/02/2026.")).toEqual([]);
    expect(extractInformationAgentFacts("Mise à prix : 120 000 € à confirmer.")).toEqual([]);
    expect(extractInformationAgentFacts("Date de la vente : 14/09/2026 reportée.")).toEqual([]);
  });

  it("does not borrow a visit date or another amount after an omitted field", () => {
    expect(
      extractInformationAgentFacts(
        "Date de la vente : prochainement. Visite le 14/09/2026. Mise à prix : à préciser. Frais : 500 €.",
      ),
    ).toEqual([]);
    expect(
      extractInformationAgentFacts("Date de la vente : 14/09/2026, visite le 15/09/2026."),
    ).toEqual([]);
  });

  it("rejects an invalid value when a repeated label later has a valid value", () => {
    expect(
      extractInformationAgentFacts("Date de la vente : 31/02/2026. Date de la vente : 14/09/2026."),
    ).toEqual([]);
    expect(extractInformationAgentFacts("Mise à prix : 0 €. Mise à prix : 120 000 €.")).toEqual([]);
  });

  it("does not promote unlabelled, quoted, visit or DPE values", () => {
    const facts = extractInformationAgentFacts(
      "Bonjour.\n> Mise à prix : 120 000 €\nVisite le 14 septembre 2026. DPE C. 130 000 €.",
    );

    expect(facts).toEqual([]);
  });
});
