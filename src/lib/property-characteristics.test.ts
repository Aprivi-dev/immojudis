import { describe, expect, it } from "vitest";
import { getPropertyCharacteristics, stateListingStatus } from "@/lib/property-characteristics";
import type { AuctionSale } from "@/lib/types";

// Bloc fictif au format écrit par la pipeline pour les cessions de l'État.
const BLOCK = {
  schema_version: "property_characteristics_v1",
  source: "cessions_etat",
  nature: [{ label: "Terrains nus", code: "terrain_nu", display: "Terrain nu" }],
  category: "Fonciers",
  items: [
    { key: "insee_code", label: "Code INSEE", value: "17990", group: "identification" },
    {
      key: "buildability",
      label: "Constructibilité",
      value: "non constructible",
      group: "urbanisme",
    },
    { key: "soil_type", label: "Type de sol", value: "argileux", group: "urbanisme" },
  ],
  surfaces: {
    land_surface_m2: "16246",
    built_surface_m2: "116.85",
    built_surface_source: "description",
  },
  energy: { dpe_class: "G" },
  media: { photos: 3, plans: 0, virtual_tours: 1 },
  attachments: [
    { label: "Cahier des charges", kind: "cahier_des_charges", kind_label: "Cahier des charges" },
    { label: "Diagnostic reglementaire", kind: "diagnostic", kind_label: "Diagnostic" },
    { label: "Diagnostic reglementaire", kind: "diagnostic", kind_label: "Diagnostic" },
  ],
  procedure: {
    method: "adjudication",
    method_label: "Adjudication",
    deadline: { at: "2026-11-05T14:30:00+01:00", kind: "adjudication" },
    prices: { starting_price_eur: "189525", deposit_eur: "18950" },
    visits: ["Visites sur rendez-vous les 15/10/2026 à 12h00"],
  },
  dates: { published_on: "2026-09-04", modified_on: "2026-09-17" },
  location: { designation: "Parcelles AM 346, 349 à Exempleville", insee_code: "17990" },
  manager: {
    service: "PRIE99 - SERVICE DE GESTION DOMANIALE",
    email: "pole@dgfip.finances.gouv.fr",
  },
};

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "sale-1",
    source_name: "cessions_etat",
    sale_venue_type: "state",
    status: "upcoming",
    sale_date: null,
    source_blocks: { caracteristiques_bien: BLOCK },
    ...overrides,
  } as unknown as AuctionSale;
}

describe("property characteristics", () => {
  it("builds groups, surfaces, procedure and attachments from the source block", () => {
    const model = getPropertyCharacteristics(sale())!;

    expect(model.origin).toBe("source");
    expect(model.official).toBe(true);
    expect(model.nature).toEqual(["Terrain nu"]);
    expect(model.groups.map((group) => group.title)).toEqual([
      "Identification",
      "Urbanisme et terrain",
      "Diagnostics",
    ]);
    expect(model.groups[2].items).toEqual([{ label: "Performance énergétique (DPE)", value: "G" }]);
    // Intl sépare les milliers par une espace fine insécable : on compare des espaces simples.
    const surfaces = model.surfaces.map((item) => ({
      ...item,
      value: item.value.replace(/\s/g, " "),
    }));
    expect(surfaces).toEqual([
      { label: "Surface bâtie (descriptif)", value: "116,85 m²" },
      { label: "Terrain", value: "16 246 m²" },
    ]);
    expect(model.media).toEqual([
      { label: "Photos", value: "3" },
      { label: "Visites virtuelles", value: "1" },
    ]);
    expect(model.attachments).toEqual([
      { label: "Cahier des charges", count: 1 },
      { label: "Diagnostic", count: 2 },
    ]);
    expect(model.procedure?.method).toBe("Adjudication");
    expect(model.procedure?.facts.map((fact) => fact.label)).toEqual([
      "Adjudication",
      "Mise à prix",
      "Consignation",
    ]);
    expect(model.procedure?.facts[0].value).toContain("2026");
    expect(model.manager).toEqual({
      service: "PRIE99 - SERVICE DE GESTION DOMANIALE",
      email: "pole@dgfip.finances.gouv.fr",
      heading: null,
    });
    expect(model.attachmentsAccess).toBeNull();
    expect(model.location[0]).toEqual({
      label: "Désignation cadastrale",
      value: "Parcelles AM 346, 349 à Exempleville",
    });
  });

  it("reads a notarial block: offer prices, restricted documents and office heading", () => {
    // Bloc fictif au format écrit par la pipeline pour une vente Immo-Interactif.
    const model = getPropertyCharacteristics(
      sale({
        source_name: "notaires",
        sale_venue_type: "notary",
        source_blocks: {
          caracteristiques_bien: {
            source: "notaires",
            nature: [{ label: "Maison / villa", code: "MAI", display: "Maison / villa" }],
            items: [{ key: "rooms", label: "Pièces", value: "5", group: "identification" }],
            attachments: [
              {
                label: "Diagnostic amiante",
                kind: "diagnostics",
                kind_label: "Diagnostic amiante",
              },
              {
                label: "Diagnostic amiante",
                kind: "diagnostics",
                kind_label: "Diagnostic amiante",
              },
            ],
            attachments_access: {
              restricted: true,
              note: "Pièces réservées aux candidats agréés.",
            },
            procedure: {
              method_label: "Vente Immo-Interactif® à la hausse (offres en ligne)",
              prices: { first_offer_eur: 139000, bid_increment_eur: 2500 },
            },
            manager: { service: "Office fictif", heading: "Office notarial" },
          },
        },
      }),
    )!;
    expect(model.attachments).toEqual([{ label: "Diagnostic amiante", count: 2 }]);
    expect(model.attachmentsAccess).toEqual({
      restricted: true,
      note: "Pièces réservées aux candidats agréés.",
    });
    expect(model.procedure?.facts.map((fact) => fact.label)).toEqual([
      "Première offre possible",
      "Pas des enchères",
    ]);
    expect(model.manager).toEqual({
      service: "Office fictif",
      email: null,
      heading: "Office notarial",
    });
  });

  it("reads a judicial listing block (Avoventes, Vench, Info-Enchères)", () => {
    // Bloc fictif au format écrit par la pipeline pour une annonce judiciaire.
    const model = getPropertyCharacteristics(
      sale({
        source_name: "avoventes",
        sale_venue_type: "tribunal",
        sale_date: "2026-11-12T13:00:00Z",
        source_blocks: {
          caracteristiques_bien: {
            schema_version: "property_characteristics_v1",
            source: "avoventes",
            items: [
              { key: "bedrooms_count", label: "Chambres", value: "3", group: "identification" },
              { key: "heating", label: "Chauffage", value: "Gaz", group: "equipements" },
            ],
            surfaces: { published_surface_m2: "64.7", land_surface_m2: "650" },
            energy: { dpe_class: "D" },
            attachments: [
              { label: "PVD.pdf", kind: "pv_huissier", kind_label: "Procès-verbal descriptif" },
            ],
            procedure: {
              prices: { preliminary_fees_eur: "9777.6", deposit_eur: "5000" },
              notes: [
                { label: "Consignation", value: "5 000,00 € (chèque de banque)" },
                { label: "Faculté de baisse de prix", value: "Oui" },
              ],
              visits: ["Le lundi 5 octobre 2026 de 9h00 à 9h30"],
            },
            location: { designation: "Parcelle V 154 à Exempleville", insee_code: "93066" },
          },
        },
      }),
    )!;

    expect(model.official).toBe(false);
    expect(model.groups.map((group) => group.title)).toEqual([
      "Identification",
      "Équipements",
      "Diagnostics",
    ]);
    expect(model.surfaces.map((item) => item.label)).toEqual(["Superficie publiée", "Terrain"]);
    expect(model.procedure?.facts.map((fact) => fact.label)).toEqual([
      "Frais préalables",
      "Consignation",
      "Faculté de baisse de prix",
    ]);
    expect(model.procedure?.visits).toEqual(["Le lundi 5 octobre 2026 de 9h00 à 9h30"]);
    expect(model.attachments).toEqual([{ label: "Procès-verbal descriptif", count: 1 }]);
    expect(model.location[0].value).toBe("Parcelle V 154 à Exempleville");
    expect(
      stateListingStatus({ ...sale(), source_name: "avoventes", sale_venue_type: "tribunal" }),
    ).toBeNull();
  });

  it("falls back on observed typed facts of any other source", () => {
    const model = getPropertyCharacteristics(
      sale({
        source_name: "licitor",
        source_blocks: {
          listing_completeness: {
            source_property_features: {
              floor: { value: "3", state: "observed" },
              heating: { value: "Gaz", state: "observed" },
              rooms_count: { value: 4, state: "inferred" },
              _extracted: { value: "ignored" },
            },
          },
        },
      }),
    )!;
    expect(model.origin).toBe("generic");
    expect(model.groups[0].items).toEqual([
      { label: "Étage", value: "3" },
      { label: "Chauffage", value: "Gaz" },
    ]);
  });

  it("renders nothing without published characteristics", () => {
    expect(getPropertyCharacteristics(sale({ source_blocks: null }))).toBeNull();
    expect(
      getPropertyCharacteristics(sale({ source_blocks: { caracteristiques_bien: {} } })),
    ).toBeNull();
  });
});

describe("state listing status", () => {
  it("labels an undated pending state procedure", () => {
    const pending = sale({
      source_blocks: { caracteristiques_bien: { ...BLOCK, procedure: { pending: true } } },
    });
    expect(stateListingStatus(pending)?.label).toBe("Procédure à venir");
  });

  it("points to the tender documents when the deadline is not published", () => {
    const open = sale({
      source_blocks: {
        caracteristiques_bien: {
          ...BLOCK,
          procedure: { method_label: "Appel d'offres", listing_end_estimate: "2026-11-27" },
        },
      },
    });
    const status = stateListingStatus(open)!;
    expect(status.label).toBe("Date limite au cahier des charges");
    expect(status.detail).toContain("27 novembre 2026");
  });

  it("uses the generic badge on the public preview and ignores dated or other sales", () => {
    expect(stateListingStatus(sale({ source_blocks: null }))?.label).toBe("Procédure à venir");
    expect(stateListingStatus(sale({ sale_date: "2026-11-05T13:30:00Z" }))).toBeNull();
    expect(stateListingStatus(sale({ status: "past" }))).toBeNull();
    expect(
      stateListingStatus(sale({ source_name: "licitor", sale_venue_type: "tribunal" })),
    ).toBeNull();
  });
});
