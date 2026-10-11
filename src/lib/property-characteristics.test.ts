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
    });
    expect(model.location[0]).toEqual({
      label: "Désignation cadastrale",
      value: "Parcelles AM 346, 349 à Exempleville",
    });
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
