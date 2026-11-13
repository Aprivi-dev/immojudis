/** Textes d'un risque de vente (libellé, preuves, extraits) à analyser. */
import type { SaleRisk } from "@/lib/types";
import { cleanTextDeep } from "@/lib/clean-text";

export type RiskTextOptions = {
  /** Le code du risque (`risk_type`) en tête, pour les analyses qui cherchent un thème par mot. */
  withType?: boolean;
  /**
   * Seulement ce que disent les pièces : sans l'explication rédigée par le modèle (`reasoning`,
   * `why_it_matters`, `next_action`). Les analyses qui relèvent des montants, des références
   * cadastrales ou des règles d'urbanisme ne lisent que les extraits, pas un texte généré.
   */
  excerptsOnly?: boolean;
  /** Les termes repérés dans chaque occurrence (`matched_terms`), lus par l'analyse cadastrale. */
  matchedTerms?: boolean;
};

export function riskTexts(risk: SaleRisk, options: RiskTextOptions = {}): string[] {
  const texts: unknown[] = [
    ...(options.withType ? [risk.risk_type] : []),
    risk.risk_label,
    risk.evidence,
  ];
  const evidence = risk.evidence_json;
  if (evidence && typeof evidence === "object") {
    const record = evidence as Record<string, unknown>;
    texts.push(record.excerpt);
    if (!options.excerptsOnly) {
      texts.push(record.reasoning, record.why_it_matters, record.next_action);
    }
  }
  for (const occurrence of risk.occurrences ?? []) {
    texts.push(occurrence.document_label, occurrence.document_type, occurrence.excerpt);
    if (options.matchedTerms) texts.push(occurrence.matched_terms);
  }
  return texts.map(cleanTextDeep).filter((text): text is string => Boolean(text));
}
