/*
 * Textes de la carte de déblocage d'une fiche (`SaleUnlockPanel`), à part des textes du déblocage
 * (`sale-unlocks.ts`), que chargent l'accueil, le catalogue et la plupart des pages : seule la fiche
 * les charge (`scripts/check-build-budgets.mjs`).
 */

/**
 * Au-dessus du bouton, avant la confirmation. Le texte invite à se servir du déblocage (18/11/2026) :
 * « choisissez-la » poussait à le garder en réserve.
 */
export const UNLOCK_CHOICE_TEXT =
  "Votre déblocage gratuit est disponible : utilisez-le sur cette vente pour voir son analyse complète.";

/**
 * Dit avant le clic que ce déblocage est celui du compte gratuit (il n'y en a qu'un), et quand il est
 * rendu. Les offres et les conditions générales (article 2) disent qu'il est définitif.
 */
export const UNLOCK_CONFIRMATION_TEXT =
  "Vous utilisez le déblocage compris dans votre compte gratuit. Il vous est rendu si la vente est retirée avant d’avoir lieu (conditions générales, article 2).";

/**
 * Comment ouvrir la vente affichée quand le déblocage a servi ailleurs. `analysisOpen` : la
 * souscription à l'offre Analyse est réellement ouverte (`useAnalysisCheckoutOpen() === true`) ;
 * sinon la phrase constate sans promettre une souscription fermée.
 */
export function unlockQuotaReachedText({ analysisOpen = false }: { analysisOpen?: boolean } = {}) {
  return analysisOpen
    ? "Pour ouvrir celle-ci aussi, passez à l’offre Analyse : elle ouvre toutes les ventes."
    : "Le compte gratuit ne débloque qu’une vente ; l’offre Analyse les ouvre toutes.";
}
