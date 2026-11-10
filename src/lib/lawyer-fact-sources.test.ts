import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLawyerFactSources,
  LAWYER_DAY_LABEL,
  LAWYER_FACT_KEYS,
  LAWYER_ROOMS_LABEL,
  lawyerFactMention,
  lawyerNoteSentences,
  lawyerSourceForDisplayedValue,
  LawyerFactSourcesReadError,
  parseLawyerFactSources,
  warnLawyerFactSourcesFailure,
  withLawyerFactSources,
  type LawyerFactSource,
} from "./lawyer-fact-sources";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const MENTION =
  "Information transmise par l’avocat poursuivant le 12/11/2026, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente.";
const source = (key: LawyerFactSource["key"], receivedOn = "2026-11-12"): LawyerFactSource => ({
  key,
  receivedOn,
  mode: "manual",
});

afterEach(() => vi.restoreAllMocks());

describe("texte de la mention", () => {
  it("dit le texte validé, avec la date de réception au format JJ/MM/AAAA", () => {
    expect(lawyerFactMention({ receivedOn: "2026-11-12", mode: "manual" })).toBe(MENTION);
  });

  it("ajoute « extraite automatiquement » pour une publication automatique", () => {
    expect(lawyerFactMention({ receivedOn: "2026-01-05", mode: "auto" })).toBe(
      "Information transmise par l’avocat poursuivant le 05/01/2026, extraite automatiquement, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente.",
    );
  });

  it("garde le texte validé pour une seule valeur sans libellé", () => {
    expect(lawyerNoteSentences([{ label: "", source: source("starting_price_eur") }])).toEqual([
      MENTION,
    ]);
    expect(lawyerNoteSentences([{ label: "", source: null }])).toEqual([]);
  });

  it("nomme les valeurs d'un bloc en une seule phrase par jour de réception", () => {
    expect(
      lawyerNoteSentences([
        { label: "Type de bien", source: source("property_type") },
        { label: "Surface", source: source("surface_m2") },
        { label: LAWYER_ROOMS_LABEL, source: null },
      ]),
    ).toEqual([
      "Type de bien et surface : information transmise par l’avocat poursuivant le 12/11/2026, non vérifiée par Immojudis. Vérifiez-les dans le cahier des conditions de vente.",
    ]);
    expect(
      lawyerNoteSentences([
        { label: "Surface", source: source("surface_m2") },
        { label: LAWYER_ROOMS_LABEL, source: source("rooms_count", "2026-11-14") },
      ]),
    ).toEqual([
      "Surface : information transmise par l’avocat poursuivant le 12/11/2026, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente.",
      "Nombre de pièces (sans les chambres) : information transmise par l’avocat poursuivant le 14/11/2026, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente.",
    ]);
  });

  it("borne la date au jour et les pièces au nombre de pièces", () => {
    expect(LAWYER_DAY_LABEL).toBe("Jour de la vente (sans l’heure)");
    expect(LAWYER_ROOMS_LABEL).toBe("Nombre de pièces (sans les chambres)");
  });
});

describe("lecture de la projection publique", () => {
  it("couvre exactement les clés qui ont une colonne affichée", () => {
    expect([...LAWYER_FACT_KEYS].sort()).toEqual(
      [
        "land_surface_m2",
        "occupancy_status",
        "property_type",
        "rooms_count",
        "sale_date",
        "starting_price_eur",
        "surface_m2",
      ].sort(),
    );
  });

  it("garde les lignes conformes et ignore le reste", () => {
    expect(
      parseLawyerFactSources([
        { fact_key: "surface_m2", received_on: "2026-11-12", publication_mode: "manual" },
        { fact_key: "surface_m2", received_on: "2026-11-14", publication_mode: "manual" },
        { fact_key: "rooms_count", received_on: "2026-11-13", publication_mode: "auto" },
        { fact_key: "address", received_on: "2026-11-12", publication_mode: "manual" },
        { fact_key: "sale_date", received_on: "12/11/2026", publication_mode: "manual" },
        { fact_key: "sale_date", received_on: "2026-11-12", publication_mode: "robot" },
        null,
        "surface_m2",
      ]),
    ).toEqual([
      { key: "surface_m2", receivedOn: "2026-11-12", mode: "manual" },
      { key: "rooms_count", receivedOn: "2026-11-13", mode: "auto" },
    ]);
    expect(parseLawyerFactSources(null)).toEqual([]);
  });

  it("lit la clé, le jour de réception et le mode", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ fact_key: "surface_m2", received_on: "2026-11-12", publication_mode: "manual" }],
      error: null,
    });
    expect(await fetchLawyerFactSources({ rpc }, ID)).toEqual([source("surface_m2")]);
    expect(rpc).toHaveBeenCalledWith("get_public_sale_lawyer_fact_sources", { p_sale_id: ID });
  });

  it("répond « aucune mention » seulement quand la fonction n'existe pas encore", async () => {
    for (const code of ["PGRST202", "42883"]) {
      const rpc = vi.fn().mockResolvedValue({ data: null, error: { code, message: "absente" } });
      expect(await fetchLawyerFactSources({ rpc }, ID)).toEqual([]);
    }
  });

  it("lève toute autre erreur avec son code, rejet du client compris", async () => {
    const failing = vi.fn().mockResolvedValue({ data: null, error: { code: "57014" } });
    await expect(fetchLawyerFactSources({ rpc: failing }, ID)).rejects.toMatchObject({
      name: "LawyerFactSourcesReadError",
      code: "57014",
    });
    const rejected = vi.fn().mockRejectedValue(new Error("réseau"));
    await expect(fetchLawyerFactSources({ rpc: rejected }, ID)).rejects.toMatchObject({
      code: "network",
    });
  });

  it("trace une lecture en échec avec le code seul", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnLawyerFactSourcesFailure(new LawyerFactSourcesReadError("57014"));
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({
      scope: "public-sale-lawyer-fact-sources",
      level: "warn",
      event: "rpc_failed",
      code: "57014",
    });
  });

  it("joint les sources à la vente, et laisse la vente intacte sans source", () => {
    const sale = { id: ID };
    expect(withLawyerFactSources(sale, [])).toBe(sale);
    expect(withLawyerFactSources(sale, undefined)).toBe(sale);
    expect(withLawyerFactSources(sale, [source("sale_date")])).toEqual({
      id: ID,
      lawyer_fact_sources: [source("sale_date")],
    });
  });
});

describe("la règle : quelle source pour cette valeur affichée", () => {
  const sale = {
    property_type: "apartment",
    app_surface_m2: 54,
    land_surface_m2: 300,
    rooms_count: 3,
    occupancy_status: "vacant",
    starting_price_eur: 95_000,
    sale_date: "2026-12-15T10:00:00+01:00",
    lawyer_fact_sources: LAWYER_FACT_KEYS.map((key) => source(key)),
  };

  it("rend la source de chaque valeur affichée telle qu'elle a été transmise", () => {
    expect(lawyerSourceForDisplayedValue(sale, "property_type")?.key).toBe("property_type");
    expect(lawyerSourceForDisplayedValue(sale, "surface")?.key).toBe("surface_m2");
    expect(lawyerSourceForDisplayedValue(sale, "rooms_count")?.key).toBe("rooms_count");
    expect(lawyerSourceForDisplayedValue(sale, "occupancy_status")?.key).toBe("occupancy_status");
    expect(lawyerSourceForDisplayedValue(sale, "starting_price_eur")?.key).toBe(
      "starting_price_eur",
    );
    expect(lawyerSourceForDisplayedValue(sale, "sale_date")?.key).toBe("sale_date");
  });

  it("ne dit rien à côté d'une valeur masquée (relecture en cours, valeur absente)", () => {
    for (const value of [
      "property_type",
      "surface",
      "rooms_count",
      "occupancy_status",
      "starting_price_eur",
      "sale_date",
    ] as const) {
      expect(lawyerSourceForDisplayedValue(sale, value, { blocked: true })).toBeNull();
    }
    expect(lawyerSourceForDisplayedValue({ ...sale, rooms_count: null }, "rooms_count")).toBeNull();
    expect(
      lawyerSourceForDisplayedValue({ ...sale, occupancy_status: "unknown" }, "occupancy_status"),
    ).toBeNull();
  });

  it("attribue la surface d'une vente « terrain seul » au terrain transmis", () => {
    const land = {
      app_surface_m2: 300,
      land_surface_m2: 300,
      lawyer_fact_sources: [source("land_surface_m2")],
    };
    expect(lawyerSourceForDisplayedValue(land, "surface")?.key).toBe("land_surface_m2");
    expect(lawyerSourceForDisplayedValue(land, "surface", { surface: 300 })?.key).toBe(
      "land_surface_m2",
    );
    // Une autre surface affichée (estimée, d'une autre portée) n'est pas celle de l'avocat.
    expect(lawyerSourceForDisplayedValue(land, "surface", { surface: 20 })).toBeNull();
    expect(
      lawyerSourceForDisplayedValue(
        { ...sale, lawyer_fact_sources: [source("land_surface_m2")] },
        "surface",
      ),
    ).toBeNull();
  });

  it("ne couvre pas une date tirée des modalités de vente", () => {
    expect(
      lawyerSourceForDisplayedValue(sale, "sale_date", { displayedDate: "2026-12-14T09:00:00Z" }),
    ).toBeNull();
    expect(
      lawyerSourceForDisplayedValue(sale, "sale_date", { displayedDate: sale.sale_date })?.key,
    ).toBe("sale_date");
  });

  it("ne dit rien sans source", () => {
    expect(
      lawyerSourceForDisplayedValue({ ...sale, lawyer_fact_sources: [] }, "surface"),
    ).toBeNull();
  });
});
