import { ceilingTermText, ceilingTermWithScopeText } from "@/lib/fee-regime-labels";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";
import { launchOfferText } from "@/lib/launch-offer";
import type { SaleUnlockPurchaseRefusalCode } from "@/lib/analysis-offer";
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

/** Ce que le compte gratuit permet de débloquer, en quelques mots. */
export const FREE_UNLOCK_TEXT = "une vente à débloquer";

/** La même chose en tête d'une liste (« Une vente à débloquer : … »). */
export const FREE_UNLOCK_LABEL = `${FREE_UNLOCK_TEXT.charAt(0).toUpperCase()}${FREE_UNLOCK_TEXT.slice(1)}`;

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
  /**
   * Crédits de déblocage disponibles : un achat à l'unité payé dont la vente a été retirée, ou
   * n'était plus débloquable au paiement. Absent d'une base pas encore migrée : zéro.
   */
  credits?: number;
  /** Comment cette vente a été débloquée ; absent ou `null` : inconnu, ou vente non débloquée. */
  source?: SaleUnlockSource | null;
};

/** Ce qui a ouvert une vente : le déblocage du compte gratuit, un achat à l'unité, un crédit. */
export type SaleUnlockSource = "free" | "purchase" | "credit";

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
  /** Comment la vente a été débloquée, quand le serveur le sait. */
  source?: SaleUnlockSource | null;
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
 * Ce qu'un déblocage ouvre sur cette vente, en une phrase : l'analyse complète de la vente,
 * c'est-à-dire tout ce que l'offre Analyse donne sur une vente (décision du propriétaire du
 * 15/11/2026). La liste est entre parenthèses pour se glisser après « Ce déblocage ouvre » comme
 * après « Pour cette vente seulement : ». Le montant plafond n'existe que pour une vente dont un régime de frais est ouvert
 * (`ceiling` : son libellé avec l'article, « l’enchère plafond » ou « l’offre plafond », ou `null`
 * quand la vente n'en a pas) et les statistiques du tribunal tant que leur drapeau est ouvert : on ne
 * promet jamais un élément que la fiche n'affiche pas.
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
    "l’estimation détaillée et les ventes comparables",
    "la lecture des pièces",
    "l’historique de la vente",
    ...(statistics ? ["les statistiques du tribunal"] : []),
    "l’urbanisme et le cadastre",
    "les pièces du dossier",
    "le rapport PDF",
  ];
  return `l’analyse complète de la vente (${items.slice(0, -1).join(", ")} et ${items[items.length - 1]})`;
}

/** Ce qui entoure le nom du plafond dans les deux textes courts ci-dessous. */
const UNLOCK_HIGHLIGHTS_PREFIX = "l’analyse complète de la vente : ";
const UNLOCK_HIGHLIGHTS_REST =
  ", estimation détaillée et ventes comparables, lecture des pièces, historique, urbanisme et rapport PDF, selon la vente";

/**
 * Les éléments que l'on cite en un mot pour présenter le compte gratuit (accueil). Une version
 * courte de `unlockedItemsText` : `sale-unlocks.test.ts` vérifie que chacun y figure, pour que les
 * deux ne dérivent pas. Ce qu'un déblocage ouvre dépend de la vente (le plafond n'existe que pour
 * les ventes dont un régime de frais est ouvert, et son nom change : « enchère plafond » ou « offre
 * plafond ») : on le dit, on ne promet pas la même chose pour toutes. `open` : les régimes ouverts
 * (tous ceux qui sont définis par défaut).
 */
export function unlockHighlightsText(open?: readonly FeeRegimeKey[]): string {
  return `${UNLOCK_HIGHLIGHTS_PREFIX}${ceilingTermWithScopeText(open)}${UNLOCK_HIGHLIGHTS_REST}`;
}

/**
 * La même liste sans précision entre parenthèses, pour une phrase qui la met déjà entre
 * parenthèses (onboarding).
 */
export function unlockHighlightsInlineText(open?: readonly FeeRegimeKey[]): string {
  return `${UNLOCK_HIGHLIGHTS_PREFIX}${ceilingTermText(open)}${UNLOCK_HIGHLIGHTS_REST}`;
}

// Ces deux textes sont ceux de `unlockHighlightsText()` et `unlockHighlightsInlineText()` pour les
// régimes ouverts par défaut (tous ceux qui sont définis). Ils sont écrits en toutes lettres pour que
// les pages qui les citent (accueil, connexion, accueil du compte, favoris) n'embarquent pas le
// calcul des termes ; `sale-unlocks.test.ts` vérifie qu'ils restent égaux à ce calcul.
export const UNLOCK_HIGHLIGHTS_TEXT =
  "l’analyse complète de la vente : enchère plafond (ventes au tribunal et ventes notariales à la bougie) ou offre plafond (ventes notariales interactives), estimation détaillée et ventes comparables, lecture des pièces, historique, urbanisme et rapport PDF, selon la vente";
export const UNLOCK_HIGHLIGHTS_INLINE_TEXT =
  "l’analyse complète de la vente : enchère plafond ou offre plafond, estimation détaillée et ventes comparables, lecture des pièces, historique, urbanisme et rapport PDF, selon la vente";

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

/** « 1 crédit de déblocage disponible », « 2 crédits… » ; `null` sans crédit (Mon compte). */
export function unlockCreditsLine(status: Pick<SaleUnlockStatus, "credits">): string | null {
  const credits = status.credits ?? 0;
  if (credits <= 0) return null;
  return credits > 1
    ? `${credits} crédits de déblocage disponibles`
    : "1 crédit de déblocage disponible";
}

/** Comment une vente de « Mes ventes débloquées » a été ouverte ; `null` quand ce n'est pas connu. */
export function unlockSourceLabel(source: SaleUnlockSource | null | undefined): string | null {
  if (source === "free") return "Débloquée avec le compte gratuit";
  if (source === "purchase") return "Achetée";
  if (source === "credit") return "Débloquée avec un crédit";
  return null;
}

/*
 * Achat d'une vente à l'unité (décision du propriétaire du 15/11/2026) : un compte gratuit dont le
 * déblocage a servi peut acheter le déblocage d'une autre vente. Rien ne le propose tant que l'achat
 * n'est pas ouvert (`saleUnlock.open` de `GET /api/billing/offer`). Aucun prix n'est écrit ici : les
 * montants viennent de l'offre lue (`label`, `amountCents`) et du libellé de l'abonnement.
 */

/** Ce que la fiche dit pour chaque refus (409) de `POST /api/billing/sale-unlock-checkout`. */
export const SALE_UNLOCK_CHECKOUT_CONFLICT_TEXTS: Record<SaleUnlockPurchaseRefusalCode, string> = {
  analysis_access: "Votre compte a déjà accès à toutes les ventes : il n’y a rien à acheter.",
  free_unlock_available:
    "Votre compte gratuit peut encore débloquer une vente : utilisez-le pour celle-ci, sans paiement.",
  credit_available:
    "Vous avez un crédit de déblocage : utilisez-le pour cette vente, sans paiement.",
  already_unlocked: "Cette vente est déjà débloquée pour votre compte : la fiche se recharge.",
  sale_not_unlockable: SALE_NOT_UNLOCKABLE_TEXT,
};

/** Le titre de la carte quand il reste un crédit (vente achetée qui n'a pas eu lieu). */
export const UNLOCK_CREDIT_TITLE = "Vous avez un crédit de déblocage";

export const UNLOCK_CREDIT_TEXT =
  "Une vente que vous aviez achetée n’a pas eu lieu ou n’était plus disponible : son déblocage vous est rendu.";

export const UNLOCK_CREDIT_CALL_TO_ACTION_LABEL = "Débloquer cette vente avec mon crédit";

/** Dit avant le clic que le crédit est consommé, et quand il est rendu. */
export const UNLOCK_CREDIT_CONFIRMATION_TEXT =
  "Ce déblocage utilise votre crédit : il ne servira plus pour une autre vente. Il vous est rendu de nouveau si cette vente est retirée avant d’avoir lieu.";

export const SALE_PURCHASE_CHOICE_TEXT =
  "Paiement unique. L’analyse complète de cette vente, tant qu’elle est en ligne (24 mois au plus).";

/** Seconde case du recueil du consentement, avant le paiement d'une vente à l'unité. */
export const SALE_PURCHASE_IMMEDIATE_ACCESS_TEXT =
  "Je demande à accéder immédiatement à l’analyse de cette vente et je reconnais perdre mon droit de rétractation une fois l’accès fourni.";

/** Rappel sous les cases : une vente retirée donne un crédit, jamais un remboursement. */
export const SALE_PURCHASE_CREDIT_REMINDER =
  "Si la vente est retirée avant d’avoir lieu, votre achat devient un crédit pour débloquer une autre vente. Il n’est pas remboursé.";

/** Pourquoi le bouton de paiement reste désactivé. */
export const SALE_PURCHASE_CONSENT_MISSING_TEXT = "Cochez les deux cases pour accéder au paiement.";

/** Retour du paiement, tant que le serveur n'a pas confirmé le déblocage. */
export const SALE_PURCHASE_PENDING_TEXT = "Paiement reçu. L’ouverture de la vente est en cours…";

/** Retour du paiement, déblocage toujours pas confirmé après les relectures. */
export const SALE_PURCHASE_DELAYED_TEXT =
  "Paiement reçu, mais l’ouverture de la vente n’est pas encore confirmée. Rechargez la page dans quelques minutes. Si la vente n’est toujours pas ouverte, écrivez-nous depuis la page Contact en indiquant cette vente.";

/** Retour du paiement : la vente n'était plus disponible, l'achat est devenu un crédit. */
export const SALE_PURCHASE_CREDITED_TEXT =
  "Paiement reçu. Cette vente n’était plus disponible : votre achat est devenu un crédit pour débloquer une autre vente.";

/** Un montant en centimes, écrit comme un prix : « 19 € », « 40,50 € ». */
export function formatEuroCents(cents: number): string {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * Le plus petit nombre de ventes à l'unité dont le total dépasse strictement le prix d'un mois
 * d'abonnement : à partir de là, l'abonnement revient moins cher (19 € et 59 € : 4, car 3 × 19 € =
 * 57 €). `null` quand un montant manque ou n'est pas un prix positif : aucune comparaison n'est dite.
 */
export function subscriptionCheaperFrom({
  unitCents,
  subscriptionCents,
}: {
  unitCents: number;
  subscriptionCents: number | null;
}): number | null {
  if (!Number.isFinite(unitCents) || unitCents <= 0) return null;
  if (subscriptionCents == null || !Number.isFinite(subscriptionCents) || subscriptionCents <= 0) {
    return null;
  }
  return Math.floor(subscriptionCents / unitCents) + 1;
}

const NUMBER_WORDS = ["deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix"];

/** « À partir de quatre ventes » : de deux à dix en lettres, au-delà en chiffres. */
function fromSalesText(count: number): string {
  if (count === 1) return "À partir d’une vente";
  return `À partir de ${NUMBER_WORDS[count - 2] ?? String(count)} ventes`;
}

/** La phrase de comparaison, ou `null` quand le seuil ne se calcule pas. */
function cheaperFromSentence(
  prices: { unitCents: number; subscriptionCents: number | null },
  unitWording: string,
): string | null {
  const count = subscriptionCheaperFrom(prices);
  return count == null
    ? null
    : `${fromSalesText(count)}${unitWording}, l’abonnement revient moins cher.`;
}

/** Les textes des deux choix de la fiche (abonnement, puis cette vente). */
export type SaleUnlockPurchaseChoiceTexts = {
  subscriptionTitle: string;
  subscriptionText: string;
  /** Déduction des achats des 30 derniers jours ; `null` sans achat à déduire. */
  subscriptionDeduction: string | null;
  saleTitle: string;
  saleText: string;
  /** Pour un compte qui n'a rien à déduire : ce que deviendrait cet achat. */
  saleDeduction: string | null;
  saleCallToAction: string;
};

/**
 * Les deux choix proposés quand le déblocage du compte gratuit a servi et que l'achat est ouvert.
 * `subscriptionCents` : le prix mensuel lu dans le libellé de l'abonnement (`null` s'il ne s'y lit
 * pas : le libellé est repris tel quel et rien n'est comparé). `firstMonthDeductionCents` : ce que
 * le serveur déduirait du premier mois (achats à l'unité des 30 derniers jours).
 */
export function saleUnlockPurchaseChoiceTexts({
  unit,
  subscriptionLabel,
  subscriptionCents,
  firstMonthDeductionCents,
}: {
  /** L'achat à l'unité lu dans l'offre : prix affiché (« 19 € ») et montant. */
  unit: { label: string; amountCents: number };
  subscriptionLabel: string;
  subscriptionCents: number | null;
  firstMonthDeductionCents: number;
}): SaleUnlockPurchaseChoiceTexts {
  const monthly = subscriptionCents != null ? formatEuroCents(subscriptionCents) : null;
  const deduction = Math.max(0, firstMonthDeductionCents);
  return {
    subscriptionTitle: `Toutes les ventes pendant un mois : ${monthly ?? subscriptionLabel}`,
    subscriptionText: [
      "Sans engagement.",
      cheaperFromSentence({ unitCents: unit.amountCents, subscriptionCents }, " à l’unité"),
    ]
      .filter(Boolean)
      .join(" "),
    subscriptionDeduction:
      deduction > 0 && subscriptionCents != null && monthly
        ? `Vos achats à l’unité des 30 derniers jours sont déduits : ${formatEuroCents(
            Math.max(0, subscriptionCents - deduction),
          )} le premier mois, puis ${monthly} par mois.`
        : null,
    saleTitle: `Cette vente : ${unit.label}`,
    saleText: SALE_PURCHASE_CHOICE_TEXT,
    saleDeduction:
      deduction === 0
        ? `Si vous vous abonnez dans les 30 jours, ces ${unit.label} sont déduits de votre premier mois.`
        : null,
    saleCallToAction: salePurchaseCallToActionLabel(unit.label),
  };
}

/** Le bouton qui ouvre le recueil du consentement, et le lien des aperçus vers la carte. */
export function salePurchaseCallToActionLabel(label: string): string {
  return `Acheter cette vente : ${label}`;
}

/**
 * Sous la carte Découverte de /offres et dans le comparatif, seulement quand l'achat est ouvert.
 */
export function salePurchaseOfferLine(label: string): string {
  return `Vente supplémentaire à l’unité : ${label}`;
}

/**
 * Sous les cartes de /offres, achat ouvert. La seconde phrase suit le même calcul que la fiche
 * (`subscriptionCheaperFrom`).
 */
export function salePurchaseOffersNote({
  unitCents,
  subscriptionCents,
}: {
  unitCents: number;
  subscriptionCents: number | null;
}): string {
  const first = "Vous n’avez besoin que d’une vente de plus ? Elle s’achète à l’unité.";
  const comparison = cheaperFromSentence({ unitCents, subscriptionCents }, "");
  return comparison ? `${first} ${comparison}` : first;
}
