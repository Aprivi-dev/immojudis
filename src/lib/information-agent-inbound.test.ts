import { describe, expect, it, vi } from "vitest";
import {
  extractInformationAgentFacts,
  findInboundToken,
  htmlToPlainText,
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
});
