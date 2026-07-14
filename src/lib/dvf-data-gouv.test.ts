import { describe, expect, it } from "vitest";
import {
  officialRowsToCandidates,
  officialRowsToParkingSales,
  parseCsvRecords,
} from "@/lib/dvf-data-gouv";

describe("data.gouv DVF commune fallback", () => {
  it("parses quoted CSV values", () => {
    const rows = parseCsvRecords(
      "id_mutation,nature_mutation,adresse_nom_voie,valeur_fonciere\n" +
        '2025-1,Vente,"RUE DE L\'ÉGLISE, PLACE",230000\n',
    );

    expect(rows).toEqual([
      {
        id_mutation: "2025-1",
        nature_mutation: "Vente",
        adresse_nom_voie: "RUE DE L'ÉGLISE, PLACE",
        valeur_fonciere: "230000",
      },
    ]);
  });

  it("turns a single-house mutation into one comparable", () => {
    const candidates = officialRowsToCandidates(
      [
        {
          id_mutation: "2025-42",
          date_mutation: "2025-03-31",
          nature_mutation: "Vente",
          valeur_fonciere: "184210",
          code_type_local: "1",
          type_local: "Maison",
          surface_reelle_bati: "120",
          surface_terrain: "640",
          id_parcelle: "650990000A0436",
          latitude: "42.859126",
          longitude: "0.4039",
          nombre_pieces_principales: "5",
          lot1_numero: "",
          lot2_numero: "",
        },
      ],
      "house",
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      segment: "house",
      totalPrice: 184_210,
      builtSurfaceM2: 120,
      landSurfaceM2: 640,
      parcelId: "650990000A0436",
    });
    expect(candidates[0].pricePerM2).toBeCloseTo(1_535.08, 1);
  });

  it("aggregates a land-only mutation across parcels", () => {
    const candidates = officialRowsToCandidates(
      [
        {
          id_mutation: "2025-land",
          date_mutation: "2025-01-10",
          nature_mutation: "Vente",
          valeur_fonciere: "90000",
          code_type_local: "",
          surface_reelle_bati: "",
          surface_terrain: "600",
          id_parcelle: "A",
          latitude: "43.1",
          longitude: "5.1",
        },
        {
          id_mutation: "2025-land",
          date_mutation: "2025-01-10",
          nature_mutation: "Vente",
          valeur_fonciere: "90000",
          code_type_local: "",
          surface_reelle_bati: "",
          surface_terrain: "300",
          id_parcelle: "B",
          latitude: "43.11",
          longitude: "5.11",
        },
      ],
      "land",
    );

    expect(candidates[0]).toMatchObject({ landSurfaceM2: 900, pricePerM2: 100 });
  });

  it("rejects a multi-property mutation as an apartment comparable", () => {
    const rows = [
      {
        id_mutation: "2025-bulk",
        date_mutation: "2025-02-02",
        nature_mutation: "Vente",
        valeur_fonciere: "500000",
        code_type_local: "2",
        surface_reelle_bati: "50",
        id_parcelle: "P",
        latitude: "48.8",
        longitude: "2.2",
        lot1_numero: "1",
      },
      {
        id_mutation: "2025-bulk",
        date_mutation: "2025-02-02",
        nature_mutation: "Vente",
        valeur_fonciere: "500000",
        code_type_local: "2",
        surface_reelle_bati: "60",
        id_parcelle: "P",
        latitude: "48.8",
        longitude: "2.2",
        lot1_numero: "2",
      },
    ];

    expect(officialRowsToCandidates(rows, "apartment")).toEqual([]);
    expect(officialRowsToCandidates(rows, "building")[0]).toMatchObject({
      builtSurfaceM2: 110,
      pricePerM2: 500_000 / 110,
    });
  });

  it("derives a unit price only from dependency-only mutations", () => {
    const dependencyRows = ["101", "102"].map((lot) => ({
      id_mutation: "2025-parking",
      date_mutation: "2025-04-02",
      nature_mutation: "Vente",
      valeur_fonciere: "40000",
      code_type_local: "3",
      type_local: "Dépendance",
      id_parcelle: "06029000AB0010",
      lot1_numero: lot,
      latitude: "43.55",
      longitude: "7.03",
    }));

    expect(officialRowsToParkingSales(dependencyRows)).toEqual([
      expect.objectContaining({ totalPrice: 40_000, unitCount: 2, unitPrice: 20_000 }),
    ]);
    expect(
      officialRowsToParkingSales([
        ...dependencyRows,
        { ...dependencyRows[0], code_type_local: "2", surface_reelle_bati: "50" },
      ]),
    ).toEqual([]);
  });
});
