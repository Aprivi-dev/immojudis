import { describe, expect, it } from "vitest";
import { pepiteDpeDiagnostic, selectPepiteDpe, type PepiteDpeRow } from "./pepite-energy";

const row = (overrides: Partial<PepiteDpeRow> = {}): PepiteDpeRow => ({
  diagnostic_number: "2026A0001",
  dpe_class: "F",
  established_at: "2025-03-01",
  confidence: 0.9,
  ...overrides,
});
const select = (rows: PepiteDpeRow[], listingClass: unknown = null) =>
  selectPepiteDpe({ diagnostics: rows.map(pepiteDpeDiagnostic), listingClass });

describe("DPE retenu pour le coût de rénovation énergétique", () => {
  it("retient la classe de l'ADEME quand sa confiance est d'au moins 0,8", () => {
    expect(select([row({ dpe_class: "G", confidence: 0.8 })])).toEqual({
      dpeClass: "G",
      dpeSource: "ademe",
    });
    expect(select([row({ dpe_class: "F", confidence: 1 })])).toEqual({
      dpeClass: "F",
      dpeSource: "ademe",
    });
  });

  it("préfère l'ADEME à l'annonce quand les deux sources se contredisent", () => {
    expect(select([row({ dpe_class: "E", confidence: 0.95 })], "G")).toEqual({
      dpeClass: "E",
      dpeSource: "ademe",
    });
    expect(select([row({ dpe_class: "G", confidence: 0.85 })], "C")).toEqual({
      dpeClass: "G",
      dpeSource: "ademe",
    });
  });

  it("retombe sur l'annonce quand la confiance de l'ADEME est sous 0,8", () => {
    expect(select([row({ dpe_class: "G", confidence: 0.79 })], "D")).toEqual({
      dpeClass: "D",
      dpeSource: "listing",
    });
    expect(select([row({ dpe_class: "G", confidence: 0.5 })], "F")).toEqual({
      dpeClass: "F",
      dpeSource: "listing",
    });
  });

  it("ne retient jamais une classe ADEME de confiance faible quand l'annonce ne dit rien", () => {
    expect(select([row({ dpe_class: "G", confidence: 0.79 })])).toEqual({
      dpeClass: null,
      dpeSource: null,
    });
    expect(select([row({ dpe_class: "G", confidence: null })])).toEqual({
      dpeClass: null,
      dpeSource: null,
    });
  });

  it("retombe sur l'annonce quand le diagnostic de l'ADEME n'a pas de classe", () => {
    expect(select([row({ dpe_class: null, confidence: 0.99 })], "F")).toEqual({
      dpeClass: "F",
      dpeSource: "listing",
    });
  });

  it("prend le diagnostic de meilleure confiance parmi plusieurs", () => {
    expect(
      select([
        row({ diagnostic_number: "a", dpe_class: "C", confidence: 0.82 }),
        row({ diagnostic_number: "b", dpe_class: "G", confidence: 0.97 }),
        row({ diagnostic_number: "c", dpe_class: "A", confidence: 0.4 }),
      ]),
    ).toEqual({ dpeClass: "G", dpeSource: "ademe" });
  });

  it("lit la classe de l'annonce telle que la fiche la lit (casse, préfixe), et ignore une valeur invalide", () => {
    expect(select([], "f")).toEqual({ dpeClass: "F", dpeSource: "listing" });
    expect(select([], "DPE G")).toEqual({ dpeClass: "G", dpeSource: "listing" });
    for (const invalid of ["H", "", "  ", 4, null, undefined, "classe inconnue"]) {
      expect(select([], invalid), String(invalid)).toEqual({ dpeClass: null, dpeSource: null });
    }
  });

  it("rend un DPE inconnu sans diagnostic ni annonce", () => {
    expect(select([])).toEqual({ dpeClass: null, dpeSource: null });
  });
});
