import { describe, expect, it } from "vitest";
import { dedupeEvidence } from "@/lib/analysis-text";
import { collectSaleTextCandidates } from "@/lib/sale-text-candidates";
import type { AuctionSale, SaleDocumentRich, SaleRisk } from "@/lib/types";

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    description: "Texte de l'annonce",
    source_description: "Texte de la source",
    risk_notes: "Note rédigée par le modèle",
    source_blocks: { occupation: "Loué", travaux: { toiture: "à refaire" }, vide: null },
    source_blocks_by_source: { licitor: { occupation: "Libre" } },
    documents_rich: null,
    risks: null,
    ...overrides,
  } as AuctionSale;
}

const documents = [
  { type: "pv", document_type: "PV de description", label: "Procès-verbal" },
] as SaleDocumentRich[];

const risks = [
  {
    risk_type: "occupation",
    risk_label: "Bien occupé",
    evidence: "occupé",
    evidence_json: { excerpt: "bail en cours", reasoning: "texte du modèle" },
    occurrences: [],
  },
] as unknown as SaleRisk[];

const texts = (candidates: { text: string; source: string }[]) =>
  candidates.map(({ text, source }) => `${source} | ${text}`);

describe("collectSaleTextCandidates", () => {
  it("lit les sources demandées dans l'ordre : descriptions, blocs, pièces, risques", () => {
    const candidates = collectSaleTextCandidates(sale(), {
      descriptions: "each",
      sourceFields: () => true,
      documents,
      risks,
    });

    expect(texts(candidates)).toEqual([
      "Description annonce | Texte de l'annonce",
      "Description source | Texte de la source",
      "Données source | occupation: Loué",
      "Données source | travaux.toiture: à refaire",
      "Données source | vide: null",
      "Données source licitor | occupation: Libre",
      "Pièces du dossier | pv PV de description Procès-verbal",
      "Preuves de risques | Bien occupé",
      "Preuves de risques | occupé",
      "Preuves de risques | bail en cours",
      "Preuves de risques | texte du modèle",
    ]);
  });

  it("ne lit jamais `risk_notes`, texte du pipeline relu", () => {
    const candidates = collectSaleTextCandidates(sale(), {
      descriptions: "each",
      sourceFields: () => true,
      documents,
      risks,
    });

    expect(candidates.some(({ text }) => text.includes("Note rédigée"))).toBe(false);
  });

  it("`one` lit la description de la source, à défaut celle de l'annonce, une seule fois", () => {
    expect(texts(collectSaleTextCandidates(sale(), { descriptions: "one" }))).toEqual([
      "Description source | Texte de la source",
    ]);
    expect(
      texts(collectSaleTextCandidates(sale({ source_description: null }), { descriptions: "one" })),
    ).toEqual(["Description source | Texte de l'annonce"]);
  });

  it("sans option, ne lit aucune source", () => {
    expect(collectSaleTextCandidates(sale({ documents_rich: documents, risks }), {})).toEqual([]);
  });

  it("ne garde que les champs retenus, avec leur chemin et leur valeur", () => {
    const candidates = collectSaleTextCandidates(sale(), {
      sourceFields: ({ path }) => path.startsWith("occupation"),
    });

    expect(candidates).toEqual([
      {
        text: "occupation: Loué",
        source: "Données source",
        field: { path: "occupation", value: "Loué" },
      },
      {
        text: "occupation: Libre",
        source: "Données source licitor",
        field: { path: "occupation", value: "Libre" },
      },
    ]);
  });

  it("transmet les options de lecture des risques", () => {
    const candidates = collectSaleTextCandidates(sale(), {
      risks,
      riskOptions: { withType: true, excerptsOnly: true },
    });

    expect(texts(candidates)).toEqual([
      "Preuves de risques | occupation",
      "Preuves de risques | Bien occupé",
      "Preuves de risques | occupé",
      "Preuves de risques | bail en cours",
    ]);
  });
});

describe("dedupeEvidence", () => {
  it("garde la première preuve par statut, extrait (sans accents ni casse) et provenance", () => {
    const evidence = [
      { status: "occupied", excerpt: "Bien occupé", source: "Description annonce", label: "a" },
      { status: "occupied", excerpt: "bien OCCUPE", source: "Description annonce", label: "b" },
      { status: "occupied", excerpt: "Bien occupé", source: "Description source", label: "c" },
      { status: "rented", excerpt: "Bien occupé", source: "Description annonce", label: "d" },
    ];

    expect(dedupeEvidence(evidence).map(({ label }) => label)).toEqual(["a", "c", "d"]);
  });
});
