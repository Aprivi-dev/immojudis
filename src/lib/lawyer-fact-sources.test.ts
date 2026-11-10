import { describe, expect, it, vi } from "vitest";
import {
  fetchLawyerFactSources,
  LAWYER_FACT_KEYS,
  lawyerFactMention,
  lawyerFactSource,
  parseLawyerFactSources,
  withLawyerFactSources,
} from "./lawyer-fact-sources";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";

describe("lecture de la projection publique", () => {
  it("lit la clé, le jour de réception et le mode, et rien d'autre", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { fact_key: "surface_m2", received_on: "2026-11-12", publication_mode: "manual" },
        { fact_key: "rooms_count", received_on: "2026-11-13", publication_mode: "auto" },
      ],
      error: null,
    });
    expect(await fetchLawyerFactSources({ rpc }, ID)).toEqual([
      { key: "surface_m2", receivedOn: "2026-11-12", mode: "manual" },
      { key: "rooms_count", receivedOn: "2026-11-13", mode: "auto" },
    ]);
    expect(rpc).toHaveBeenCalledWith("get_public_sale_lawyer_fact_sources", { p_sale_id: ID });
  });

  it("rend une liste vide quand la fonction manque, échoue ou répond hors contrat", async () => {
    for (const answer of [
      { data: null, error: { code: "PGRST202", message: "absente" } },
      { data: null, error: { code: "57014", message: "timeout" } },
      { data: { fact_key: "surface_m2" }, error: null },
    ]) {
      expect(await fetchLawyerFactSources({ rpc: vi.fn().mockResolvedValue(answer) }, ID)).toEqual(
        [],
      );
    }
    const failing = vi.fn().mockRejectedValue(new Error("réseau"));
    expect(await fetchLawyerFactSources({ rpc: failing }, ID)).toEqual([]);
  });

  it("joint les sources à la vente, et laisse la vente intacte sans source", () => {
    const sale = { id: ID };
    expect(withLawyerFactSources(sale, [])).toBe(sale);
    expect(
      withLawyerFactSources(sale, [{ key: "sale_date", receivedOn: "2026-11-12", mode: "manual" }]),
    ).toEqual({
      id: ID,
      lawyer_fact_sources: [{ key: "sale_date", receivedOn: "2026-11-12", mode: "manual" }],
    });
  });
});

describe("source « avocat poursuivant » des valeurs de la fiche", () => {
  it("dit le texte validé, avec la date de réception au format JJ/MM/AAAA", () => {
    expect(lawyerFactMention({ receivedOn: "2026-11-12", mode: "manual" })).toBe(
      "Information transmise par l’avocat poursuivant le 12/11/2026, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente.",
    );
  });

  it("ajoute « extraite automatiquement » pour une publication automatique", () => {
    expect(lawyerFactMention({ receivedOn: "2026-01-05", mode: "auto" })).toBe(
      "Information transmise par l’avocat poursuivant le 05/01/2026, extraite automatiquement, non vérifiée par Immojudis. Vérifiez-la dans le cahier des conditions de vente.",
    );
  });

  it("ne nomme jamais l'avocat et ne cite jamais le message", () => {
    const mention = lawyerFactMention({ receivedOn: "2026-11-12", mode: "manual" });
    expect(mention).not.toMatch(/Maître|Me |SCP|cabinet|«|"/);
  });

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

  it("garde les lignes conformes et ignore le reste, sans erreur", () => {
    expect(
      parseLawyerFactSources([
        { fact_key: "surface_m2", received_on: "2026-11-12", publication_mode: "manual" },
        { fact_key: "surface_m2", received_on: "2026-11-14", publication_mode: "manual" },
        { fact_key: "rooms_count", received_on: "2026-11-13", publication_mode: "auto" },
        { fact_key: "address", received_on: "2026-11-12", publication_mode: "manual" },
        { fact_key: "visit_information", received_on: "2026-11-12", publication_mode: "manual" },
        { fact_key: "sale_date", received_on: "12/11/2026", publication_mode: "manual" },
        { fact_key: "sale_date", received_on: "2026-11-12", publication_mode: "robot" },
        { fact_key: "occupancy_status", received_on: null, publication_mode: "manual" },
        null,
        "surface_m2",
      ]),
    ).toEqual([
      { key: "surface_m2", receivedOn: "2026-11-12", mode: "manual" },
      { key: "rooms_count", receivedOn: "2026-11-13", mode: "auto" },
    ]);
    expect(parseLawyerFactSources(null)).toEqual([]);
    expect(parseLawyerFactSources({ fact_key: "surface_m2" })).toEqual([]);
  });

  it("trouve la source d'une clé de la fiche", () => {
    const sale = {
      lawyer_fact_sources: [
        { key: "rooms_count" as const, receivedOn: "2026-11-12", mode: "manual" as const },
      ],
    };
    expect(lawyerFactSource(sale, "rooms_count")).toEqual(sale.lawyer_fact_sources[0]);
    expect(lawyerFactSource(sale, "surface_m2")).toBeNull();
    expect(lawyerFactSource({}, "surface_m2")).toBeNull();
  });
});
