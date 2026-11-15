import { ceilingTermText, ceilingTermWithScopeText } from "@/lib/fee-regime-labels";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";
import { launchOfferText } from "@/lib/launch-offer";
import { PLAN_LIMITS } from "@/lib/plans";

/**
 * Le déblocage du compte gratuit (offre Découverte) : une vente en tout, sans remise à zéro. Types
 * et textes partagés par la route API, la base de données (RPC `unlock_sale` /
 * `get_sale_unlock_status`) et la fiche d'une vente. Module pur, sans import serveur. Le nombre de
 * déblocages vient de `PLAN_LIMITS.decouverte.saleUnlocks`.
 *
 * Les textes visibles écrivent « une vente » en toutes lettres : `sale-unlocks.test.ts` vérifie que
 * `FREE_SALE_UNLOCKS` vaut 1. Changer ce nombre impose de réécrire ces textes.
 */

export const FREE_SALE_UNLOCKS = PLAN_LIMITS.decouverte.saleUnlocks;

/** Ce que le compte gratuit permet de débloquer, en quelques mots (« Une vente à débloquer : … »). */
export const FREE_UNLOCK_TEXT = "une vente à débloquer";

/**
 * Ce que le compte gratuit coûte et donne, en une ligne (accueil, cartes de résultats). Les offres
 * expliquent ce que le déblocage ouvre.
 */
export const FREE_ACCESS_LINE = `Gratuit, sans carte bancaire · ${FREE_UNLOCK_TEXT}`;

/**
 * `FREE_ACCESS_LINE`, ou la mention de l'offre de lancement quand elle est active : un compte
 * gratuit a alors les avantages de l'offre Analyse, et la ligne qui présente le compte gratuit ne
 * promet plus le seul déblocage d'une vente. Texte pour un compte connecté ou pour un visiteur
 * (`src/lib/launch-offer.ts`). Les appels à l'inscription et l'accueil passent par ici.
 */
export function freeAccessLine({
  launchOffer = false,
  signedIn = false,
}: { launchOffer?: boolean; signedIn?: boolean } = {}): string {
  return launchOffer ? launchOfferText(signedIn ? "account" : "visitor") : FREE_ACCESS_LINE;
}

export type SaleUnlockStatus = {
  saleId: string | null;
  /** La vente est débloquée pour ce compte et toujours en ligne. */
  unlocked: boolean;
  /**
   * La vente peut être débloquée : en ligne et prête pour l'offre Analyse. Faux pour une vente qui
   * s'affiche en fiche gratuite mais que la base refuserait de débloquer (« Vente introuvable »).
   * Une base sans cette information (migration pas appliquée) répond `true`, comme avant.
   */
  unlockable: boolean;
  /** Le compte a déjà accès à toutes les ventes (Analyse, administrateur) : rien à débloquer. */
  analysisAccess: boolean;
  /** Déblocages compris dans le compte ; `null` quand le compte n'a pas à débloquer. */
  limit: number | null;
  used: number;
  remaining: number | null;
};

export type SaleUnlockResult = SaleUnlockStatus & {
  /** La vente était déjà débloquée : rien n'a été consommé. */
  alreadyUnlocked: boolean;
  /** Ce clic a consommé un déblocage. */
  consumed: boolean;
};

/** Une vente débloquée par le compte, telle que la liste « Mes ventes débloquées » l'affiche. */
export type UnlockedSaleSummary = {
  id: string;
  title: string | null;
  city: string | null;
  department: string | null;
  propertyType: string | null;
  startingPriceEur: number | null;
  saleDate: string | null;
  status: string | null;
};

/** Réponse de `GET /api/sale-unlocks` : le déblocage du compte et les ventes débloquées en ligne. */
export type SaleUnlocksOverview = {
  status: SaleUnlockStatus;
  sales: UnlockedSaleSummary[];
};

/** Réponse de `POST /api/sales/[id]/unlock` quand le déblocage du compte est déjà utilisé. */
export type SaleUnlockQuotaReachedResponse = {
  error: string;
  code: "unlock_quota_reached";
  status: SaleUnlockStatus;
};

/**
 * Ce qu'un déblocage ouvre sur cette vente, en une phrase. Le montant plafond n'existe que pour une
 * vente dont un régime de frais est ouvert (`ceiling` : son libellé avec l'article, « l’enchère
 * plafond » ou « l’offre plafond », ou `null` quand la vente n'en a pas) et les statistiques du
 * tribunal tant que leur drapeau est ouvert : on ne promet jamais un élément que la fiche
 * n'affiche pas.
 */
export function unlockedItemsText({
  ceiling,
  statistics,
  pepite = false,
}: {
  ceiling: string | null;
  statistics: boolean;
  /** La vente est une pépite : le détail du repère (montant, prix probable, critères) s'ouvre aussi. */
  pepite?: boolean;
}): string {
  const items = [
    ...(ceiling ? [ceiling] : []),
    ...(pepite ? ["le détail de la pépite"] : []),
    "la lecture des pièces",
    "l’historique de la vente",
    ...(statistics ? ["les statistiques du tribunal"] : []),
    "les pièces du dossier",
  ];
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}

/**
 * Les éléments que l'on cite en un mot pour présenter le compte gratuit (accueil). Une version
 * courte de `unlockedItemsText` : `sale-unlocks.test.ts` vérifie que chacun y figure, pour que les
 * deux ne dérivent pas. Ce qu'un déblocage ouvre dépend de la vente (le plafond n'existe que pour
 * les ventes dont un régime de frais est ouvert, et son nom change : « enchère plafond » ou « offre
 * plafond ») : on le dit, on ne promet pas la même chose pour toutes. `open` : les régimes ouverts
 * (tous ceux qui sont définis par défaut).
 */
export function unlockHighlightsText(open?: readonly FeeRegimeKey[]): string {
  return `${ceilingTermWithScopeText(open)}, lecture des pièces, historique, selon la vente`;
}

/**
 * La même liste sans précision entre parenthèses, pour une phrase qui la met déjà entre
 * parenthèses (onboarding).
 */
export function unlockHighlightsInlineText(open?: readonly FeeRegimeKey[]): string {
  return `${ceilingTermText(open)}, lecture des pièces, historique, selon la vente`;
}

// Ces deux textes sont ceux de `unlockHighlightsText()` et `unlockHighlightsInlineText()` pour les
// régimes ouverts par défaut (tous ceux qui sont définis). Ils sont écrits en toutes lettres pour que
// les pages qui les citent (accueil, connexion, accueil du compte, favoris) n'embarquent pas le
// calcul des termes ; `sale-unlocks.test.ts` vérifie qu'ils restent égaux à ce calcul.
export const UNLOCK_HIGHLIGHTS_TEXT =
  "enchère plafond (ventes au tribunal et ventes notariales à la bougie) ou offre plafond (ventes notariales interactives), lecture des pièces, historique, selon la vente";
export const UNLOCK_HIGHLIGHTS_INLINE_TEXT =
  "enchère plafond ou offre plafond, lecture des pièces, historique, selon la vente";

/** « Cette vente ne peut pas être débloquée pour le moment. » */
export const SALE_NOT_UNLOCKABLE_TEXT = "Cette vente ne peut pas être débloquée pour le moment.";

/** Le bouton de la fiche et le lien principal des aperçus payants. */
export const UNLOCK_CALL_TO_ACTION_LABEL = "Débloquer cette vente avec mon compte gratuit";

/** Sous le bouton, avant la confirmation. */
export const UNLOCK_CHOICE_TEXT =
  "Votre compte gratuit comprend le déblocage d’une vente : choisissez-la.";

/** Dit avant le clic que le déblocage est définitif, et quand il est rendu. */
export const UNLOCK_CONFIRMATION_TEXT =
  "Ce déblocage est définitif : votre compte gratuit n’en comprend qu’un. Il vous est rendu si la vente est retirée avant d’avoir lieu (conditions générales, article 2).";

/** Le titre de la fiche quand le déblocage du compte a servi pour une autre vente. */
export const UNLOCK_QUOTA_REACHED_TITLE = "Votre compte gratuit a déjà débloqué une vente";

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

/** « Déblocage du compte gratuit : utilisé » ou « disponible » (Mon compte, ventes débloquées). */
export function unlockUsageLine(status: Pick<SaleUnlockStatus, "remaining">): string {
  return `Déblocage du compte gratuit : ${(status.remaining ?? 0) > 0 ? "disponible" : "utilisé"}`;
}
