import type { SaleUnlockPurchaseRefusalCode } from "@/lib/sale-unlock-checkout-contract";
import { cheaperFromSentence, formatEuroCents } from "@/lib/sale-unlock-offer-texts";
import { SALE_NOT_UNLOCKABLE_TEXT } from "@/lib/sale-unlocks";

/*
 * Textes de l'achat d'une vente à l'unité (décision du propriétaire du 15/11/2026), à part des textes
 * du déblocage (`sale-unlocks.ts`), que chargent l'accueil, le catalogue et la plupart des pages :
 * seuls le bloc d'achat de la fiche et /offres les chargent.
 *
 * Achat d'une vente à l'unité : un compte gratuit dont le
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
