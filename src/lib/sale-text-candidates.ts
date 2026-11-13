import { flattenKeyValues, type FlattenedValue } from "@/lib/analysis-text";
import { cleanTextDeep, type TextCandidate } from "@/lib/clean-text";
import { riskTexts, type RiskTextOptions } from "@/lib/sale-risk-texts";
import type { AuctionSale, SaleDocumentRich, SaleRisk } from "@/lib/types";

/** Un texte lu, et le champ des blocs source dont il vient, s'il vient d'un bloc. */
export type SaleTextCandidate = TextCandidate & { field?: FlattenedValue };

/** Ce qu'une analyse lit d'une vente ; une source absente n'est pas lue. */
export type SaleTextSources = {
  /**
   * `each` : la description de l'annonce, puis celle de la source, chacune citée avec sa provenance.
   * `one` : un seul texte, la description de la source ou, à défaut, celle de l'annonce.
   */
  descriptions?: "each" | "one";
  /** Champs des blocs source à lire, chacun en « chemin: valeur » (blocs fusionnés, puis par source). */
  sourceFields?: (field: FlattenedValue) => boolean;
  /** Pièces du dossier : type, nature et libellé de chacune. */
  documents?: readonly SaleDocumentRich[] | null;
  /** Risques de la vente, lus par `riskTexts` avec `riskOptions`. */
  risks?: readonly SaleRisk[] | null;
  riskOptions?: RiskTextOptions;
};

/**
 * Les textes d'une vente où une analyse cherche ses indices, dans l'ordre : descriptions, blocs
 * source, pièces, risques. Chaque analyse filtre ensuite ceux qui la concernent.
 *
 * `risk_notes`, les scores et les résumés générés n'y entrent jamais : c'est le texte du pipeline
 * (sortie du modèle) relu, pas une preuve indépendante sur le bien.
 */
export function collectSaleTextCandidates(
  sale: AuctionSale,
  sources: SaleTextSources,
): SaleTextCandidate[] {
  const candidates: SaleTextCandidate[] = [];
  const add = (value: unknown, source: string, field?: FlattenedValue) => {
    const text = cleanTextDeep(value);
    if (text) candidates.push(field ? { text, source, field } : { text, source });
  };

  if (sources.descriptions === "each") {
    add(sale.description, "Description annonce");
    add(sale.source_description, "Description source");
  } else if (sources.descriptions === "one") {
    add(sale.source_description ?? sale.description, "Description source");
  }

  const { sourceFields } = sources;
  if (sourceFields) {
    const addFields = (blocks: unknown, source: string) => {
      for (const field of flattenKeyValues(blocks)) {
        if (sourceFields(field)) add(`${field.path}: ${cleanTextDeep(field.value)}`, source, field);
      }
    };
    addFields(sale.source_blocks ?? {}, "Données source");
    for (const [sourceName, blocks] of Object.entries(sale.source_blocks_by_source ?? {})) {
      addFields(blocks, `Données source ${sourceName}`);
    }
  }

  for (const document of sources.documents ?? []) {
    add(
      `${document.type ?? ""} ${document.document_type ?? ""} ${document.label ?? ""}`,
      "Pièces du dossier",
    );
  }

  for (const risk of sources.risks ?? []) {
    for (const text of riskTexts(risk, sources.riskOptions)) add(text, "Preuves de risques");
  }

  return candidates;
}
