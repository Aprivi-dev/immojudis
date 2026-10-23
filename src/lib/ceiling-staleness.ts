import type { SaleChangeEventKind, SaleChangeEventSummary } from "@/lib/sale-change-monitor";

/**
 * « Plafond à vérifier » (n° 92) : les changements qui peuvent rendre une enchère plafond enregistrée
 * caduque. Module pur et léger, sans les libellés de `sale-change-display` (ils seraient recopiés dans
 * chaque copie du bloc « Mon dossier » chargé à la demande) : seul le TYPE des événements est importé.
 */
const CEILING_EVENT_TOPICS: Partial<Record<SaleChangeEventKind, string>> = {
  price_changed: "la mise à prix",
  audience_changed: "la date de la vente",
  documents_changed: "les documents",
};

export type CeilingStaleness = {
  /** Ce qui a changé, dans l'ordre d'apparition : « la mise à prix », « les documents »… */
  topics: string[];
  /** Détection du changement le plus récent (ISO). */
  lastDetectedAt: string;
};

/**
 * Les changements détectés sur une vente APRÈS l'enregistrement de l'enchère plafond de la
 * personne (`bid_ceiling_saved_at`) : mise à prix, date de la vente, documents. Un statut (vente
 * reportée, retirée) a son propre avertissement ; le score n'est pas un changement de la vente. Les
 * événements écartés par la personne (`dismissedAt`) comptent : écarter un message ne défait pas le
 * changement. `null` quand rien n'a changé depuis, ou quand la date d'enregistrement manque.
 */
export function changesSinceCeiling(
  events: readonly SaleChangeEventSummary[],
  savedAt: string | null,
): CeilingStaleness | null {
  const saved = savedAt ? Date.parse(savedAt) : NaN;
  if (!Number.isFinite(saved)) return null;
  const topics = new Set<string>();
  let last = -Infinity;
  const oldestFirst = [...events].sort(
    (a, b) => Date.parse(a.detectedAt) - Date.parse(b.detectedAt),
  );
  for (const event of oldestFirst) {
    const detected = Date.parse(event.detectedAt);
    if (!Number.isFinite(detected) || detected <= saved) continue;
    const label = CEILING_EVENT_TOPICS[event.eventKind];
    if (!label) continue;
    topics.add(label);
    last = Math.max(last, detected);
  }
  return topics.size ? { topics: [...topics], lastDetectedAt: new Date(last).toISOString() } : null;
}
