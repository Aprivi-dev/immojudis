import { useQuery } from "@tanstack/react-query";
import {
  autopilotQuery,
  catalogueReadinessQuery,
  reviewQuery,
  unroutedQuery,
} from "@/components/admin/information-agent-queries";

/** Une valeur du bandeau : `value` reste null tant qu'elle est inconnue (chargement ou erreur). */
export type SummaryValue<T> = { value: T | null; failed: boolean };

/** Réponses à traiter : réponses reçues à relire et messages reçus sans dossier. */
export type InformationAgentReplies = {
  toReview: SummaryValue<number>;
  unrouted: SummaryValue<number>;
  /** Réponses à relire + messages non rattachés ; null tant que l'une des deux valeurs est inconnue. */
  replies: number | null;
  /** Vrai quand « réponses » est tranché (valeur reçue ou en erreur) : on peut choisir l'onglet d'accueil. */
  repliesSettled: boolean;
};

export type InformationAgentSummaryData = InformationAgentReplies & {
  pilotMode: SummaryValue<"off" | "simulation" | "live">;
  /** Arrêté automatiquement par un seuil ; le motif en clair est dans `pilotNotice`. */
  pilotAutoStopped: boolean;
  pilotNotice: { tone: "alert" | "warn"; text: string } | null;
  sentToday: SummaryValue<string>;
  contactable: SummaryValue<number>;
};

type QueryLike<T> = { data: T | undefined; isError: boolean };
const pick = <Raw, T>(query: QueryLike<Raw>, read: (data: Raw) => T): SummaryValue<T> => ({
  value: query.data === undefined ? null : (read(query.data) ?? null),
  failed: query.isError && query.data === undefined,
});

/**
 * Seule définition des « réponses à traiter » : le bandeau de l'agent et l'accueil de l'administration
 * la lisent. Mêmes requêtes que l'onglet Réponses (mêmes clés) : aucune requête en plus.
 */
export function useInformationAgentReplies(): InformationAgentReplies {
  const review = useQuery(reviewQuery(0));
  const unrouted = useQuery(unroutedQuery(0));

  const toReview = pick(review, (data) => data.messagesTotal);
  const unroutedCount = pick(unrouted, (data) => data.total);
  return {
    toReview,
    unrouted: unroutedCount,
    replies:
      toReview.value !== null && unroutedCount.value !== null
        ? toReview.value + unroutedCount.value
        : null,
    repliesSettled:
      (toReview.value !== null || toReview.failed) &&
      (unroutedCount.value !== null || unroutedCount.failed),
  };
}

/**
 * Données du bandeau de synthèse et des compteurs d'onglets. Elles viennent des requêtes que les
 * panneaux font déjà (mêmes clés, `information-agent-queries.ts`) : aucune route nouvelle, et une
 * seule requête par liste même quand le panneau et le bandeau sont affichés ensemble. Ne retient que
 * des nombres et des libellés : jamais d'adresse email ni de contenu de message.
 */
export function useInformationAgentSummary(): InformationAgentSummaryData {
  const pilot = useQuery(autopilotQuery());
  const readiness = useQuery(catalogueReadinessQuery(0));

  return {
    ...useInformationAgentReplies(),
    pilotMode: pick(pilot, (data) => data.mode),
    pilotAutoStopped: pilot.data?.autoStopped === true,
    pilotNotice: pilot.data?.notice ?? null,
    sentToday: pick(pilot, (data) => data.sentToday),
    contactable: pick(readiness, (data) => data.total),
  };
}
