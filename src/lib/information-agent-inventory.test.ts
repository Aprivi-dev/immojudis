import { describe, expect, it, vi } from "vitest";
import { getKeyFactReliabilities } from "@/lib/fact-reliability";
import {
  buildInformationAgentInventory,
  type InformationAgentInventorySale,
} from "@/lib/information-agent-inventory";
import {
  buildInformationRequestDraft,
  detectInformationGaps,
  informationAgentQuestionText,
} from "@/lib/information-agent";
import type { AuctionSale } from "@/lib/types";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
}));

function inventoryOf(sale: InformationAgentInventorySale) {
  return buildInformationAgentInventory(sale, getKeyFactReliabilities(sale));
}

function statusOf(sale: InformationAgentInventorySale, key: string) {
  return inventoryOf(sale).items.find((item) => item.key === key)?.status;
}

function baseSale(overrides: Partial<InformationAgentInventorySale> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Maison à Eyragues",
    property_type: "house",
    city: "Eyragues",
    postal_code: "13630",
    tribunal: "Tribunal judiciaire de Tarascon",
    sale_venue_type: "tribunal",
    sale_date: "2026-10-12T07:00:00.000Z",
    starting_price_eur: 120_000,
    source_name: "avoventes",
    documents: null,
    documents_rich: null,
    media: null,
    visit_dates: null,
    occupancy_status: null,
    habitable_surface_m2: null,
    rooms_count: null,
    sale_procedure: null,
    source_blocks: null,
    ...overrides,
  } as InformationAgentInventorySale;
}

describe("inventaire de la fiche pour l'agent d'information", () => {
  it("s'appuie sur les blocs source (pièces citées, visite en texte libre, occupation)", () => {
    const sale = baseSale({
      visit_dates: [
        "Une visite des lieux sera assurée par la SCP Exemple LE LUNDI 05 OCTOBRE 2026 DE 14H00 A 15H00.",
      ],
      source_blocks: {
        documents:
          "CCV NOUVEAU.pdf; annonce normale.pdf; PV DESCRIPTION.pdf; diagnostics techniques.pdf",
        occupation: "rented",
        surface: "82,99 m²",
      },
      habitable_surface_m2: 82.99,
      rooms_count: 4,
    });
    const inventory = inventoryOf(sale);
    const byKey = Object.fromEntries(inventory.items.map((item) => [item.key, item.status]));

    expect(byKey).toMatchObject({
      hearing: "present",
      venue: "present",
      starting_price: "present",
      surface: "present",
      occupancy: "present",
      visits: "present",
      sale_conditions: "present",
      pv_descriptif: "present",
      diagnostics: "present",
      composition: "present",
      sale_terms: "present",
    });
    expect(inventory.missingDocuments).toEqual([]);
    // Seuls restent les photos et la référence cadastrale : rien de ce qui est connu n'est redemandé.
    expect(detectInformationGaps(sale).map((gap) => gap.key)).toEqual(["photos", "cadastre"]);
  });

  it("lit la fiche « caractéristiques du bien » d'une cession de l'État", () => {
    const sale = baseSale({
      source_name: "cessions_etat",
      sale_venue_type: "state",
      tribunal: null,
      sale_date: null,
      starting_price_eur: null,
      property_type: "commercial",
      source_blocks: {
        caracteristiques_bien: {
          source: "cessions_etat",
          media: { photos: 17 },
          surfaces: { built_surface_m2: "1193" },
          location: { designation: "Parcelles CX 384, 518, 519 à Dijon" },
          procedure: {
            method: "encheres_en_ligne",
            method_label: "Enchères en ligne",
            deadline: { at: "2026-10-15T16:00:00+02:00", kind: "sale_window_close" },
            prices: { starting_price_eur: 950000 },
          },
          attachments: [
            { kind: "cahier_des_charges", kind_label: "Cahier des charges" },
            { kind: "diagnostic", kind_label: "Diagnostic" },
          ],
        },
      },
    });
    const inventory = inventoryOf(sale);
    const byKey = Object.fromEntries(inventory.items.map((item) => [item.key, item.status]));

    expect(inventory.judicial).toBe(false);
    expect(byKey).toMatchObject({
      hearing: "present",
      venue: "present",
      starting_price: "present",
      surface: "present",
      photos: "present",
      cadastre: "present",
      sale_conditions: "present",
      diagnostics: "present",
      pv_descriptif: "not_applicable",
    });
    const keys = detectInformationGaps(sale).map((gap) => gap.key);
    expect(keys).not.toContain("documents");
    expect(keys).not.toContain("sale_date");
    expect(keys).toEqual(expect.arrayContaining(["occupancy", "visit"]));
  });

  it("reprend les faits extraits des PDF sans les recopier", () => {
    const sale = baseSale({
      information_agent_signals: {
        pdfFacts: {
          occupancy: { documentLabel: "PV descriptif", documentType: "pv_huissier", page: 14 },
          rooms: { documentLabel: "PV descriptif", documentType: "pv_huissier", page: 2 },
        },
      },
    });
    const items = inventoryOf(sale).items;
    expect(items.find((item) => item.key === "occupancy")).toMatchObject({
      status: "present",
      origin: "Pièce : PV descriptif, page 14",
    });
    expect(items.find((item) => item.key === "composition")?.status).toBe("present");
    expect(detectInformationGaps(sale).map((gap) => gap.key)).not.toContain("occupancy");
  });

  it("ne demande ni surface, ni pièces, ni diagnostics pour un parking", () => {
    const sale = baseSale({ property_type: "parking" });
    expect(statusOf(sale, "surface")).toBe("not_applicable");
    expect(statusOf(sale, "composition")).toBe("not_applicable");
    expect(statusOf(sale, "diagnostics")).toBe("not_applicable");
    const documents = detectInformationGaps(sale).find((gap) => gap.key === "documents");
    expect(documents?.reason).not.toContain("diagnostics");
  });

  it("garde une surface estimée ou contradictoire dans les questions", () => {
    const conflicting = baseSale({
      habitable_surface_m2: 80,
      source_conflicts: [{ field: "surface", selected: "80", alternative: "95" }],
    } as Partial<AuctionSale>);
    expect(statusOf(conflicting, "surface")).toBe("to_confirm");
    expect(detectInformationGaps(conflicting).map((gap) => gap.key)).toContain("surface");
  });

  it("nomme précisément les pièces manquantes et adapte la question de date", () => {
    expect(
      informationAgentQuestionText("documents", {
        judicial: true,
        venueMissing: false,
        missingDocuments: ["pv_descriptif", "diagnostics"],
      }),
    ).toBe(
      "Pourriez-vous nous transmettre le procès-verbal descriptif et le dossier de diagnostics techniques, ou nous indiquer où les consulter, en précisant leur date ou leur version si elle est connue ?",
    );
    expect(
      informationAgentQuestionText("sale_date", {
        judicial: false,
        venueMissing: true,
        missingDocuments: [],
      }),
    ).toContain("date limite de dépôt des offres, ainsi que le lieu ou la plateforme de vente");

    const draft = buildInformationRequestDraft({
      sale: baseSale({ sale_venue_type: "notary", tribunal: null, source_name: "notaires" }),
      questionKeys: ["documents"],
    });
    expect(draft.bodyText).toContain("Date de vente annoncée");
    expect(draft.bodyText).not.toContain("Audience annoncée");
    expect(draft.bodyText).toContain("le cahier des conditions de vente");
    // Le PV descriptif n'est pas demandé hors vente judiciaire (la réserve de secret professionnel
    // du message le cite, comme pièce communicable).
    expect(draft.bodyText).not.toContain("transmettre le procès-verbal descriptif");
    expect(draft.bodyText).not.toContain("le procès-verbal descriptif et le dossier");
  });
});
