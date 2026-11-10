import { resolveAnalysisOfferLabel } from "@/lib/analysis-offer";

/**
 * Mention courte de l'offre partout où son prix apparaît (10/11/2026 : l'offre Analyse est un
 * abonnement mensuel prélevé chaque mois jusqu'à résiliation, plus l'ancien accès de 30 jours sans
 * renouvellement). Exemple : « abonnement à 59 € TTC / mois, prélevé automatiquement chaque mois
 * jusqu’à résiliation, résiliable à tout moment ». Module à part : il n'alourdit pas les pages qui ne
 * citent pas le prix (budget JavaScript de /sales).
 */
export function analysisSubscriptionTerms(label: string = resolveAnalysisOfferLabel()): string {
  return `abonnement à ${label}, prélevé automatiquement chaque mois jusqu’à résiliation, résiliable à tout moment`;
}
