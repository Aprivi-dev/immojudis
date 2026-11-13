/**
 * Fenêtre de surenchère d'une vente judiciaire dont l'audience est passée (point 70).
 *
 * Seul le calcul de la date vit ici, comme `surenchere.ts` pour le montant. La règle (qui peut
 * surenchérir, par acte d'avocat, dans quels types de vente) est celle de l'article
 * `apres-adjudication-surenchere-paiement-titre-vente` : rien n'est réécrit.
 *
 * La date est INDICATIVE : dix jours calendaires après le jour de l'audience connu d'Immojudis (jour
 * civil à Paris), qui peut avoir changé. Elle ne tient PAS compte du report éventuel au premier jour
 * ouvrable suivant (samedi, dimanche, jour férié) : ce calcul attend l'avis d'un avocat et n'est pas
 * implémenté. L'écran (`PastFollowedSales`) et l'email (`surenchereLines`) disent que le délai peut
 * être prolongé et qu'il ne faut pas compter dessus sans l'avis d'un avocat ; une fois la date
 * passée, ils disent que le délai a pu expirer ou être prolongé. Ils ne présentent jamais cette date
 * comme une échéance ferme (ni « fenêtre échue », ni nombre de jours restants, ni « dernier jour »)
 * et renvoient à un avocat, de préférence du barreau du tribunal, dont le choix reste libre.
 */

import { parisDateKey, parisDateKeyOrNull } from "@/lib/paris-time";
import { addDays } from "@/lib/calendar-day";

/** Délai de la surenchère du dixième après l'adjudication en vente judiciaire (R. 322-50 du CPCE). */
export const SURENCHERE_WINDOW_DAYS = 10;

export type SurenchereWindow =
  /** Vente qui n'est pas judiciaire (notaire, État, en ligne) ou de type inconnu : aucune fenêtre calculée. */
  | { kind: "not_applicable" }
  /** Vente judiciaire sans date d'audience exploitable : rien à calculer. */
  | { kind: "no_date" }
  | {
      kind: "window";
      /** Jour de l'audience à Paris (AAAA-MM-JJ). */
      hearingDay: string;
      /** Date indicative, sans report éventuel (AAAA-MM-JJ). */
      deadline: string;
      /** Vrai quand le résultat « adjugé » est connu ; faux : la fenêtre n'existe que si le bien a été adjugé. */
      adjudicationConfirmed: boolean;
      /** Vrai quand le jour courant (Paris) est après la date indicative. */
      expired: boolean;
    };

export function surenchereWindow({
  saleDate,
  venueType,
  adjudicationConfirmed,
  now = new Date(),
}: {
  saleDate: string | null | undefined;
  venueType: string | null | undefined;
  adjudicationConfirmed: boolean;
  now?: Date;
}): SurenchereWindow {
  if (venueType !== "tribunal") return { kind: "not_applicable" };
  const hearingDay = parisDateKeyOrNull(saleDate);
  if (!hearingDay) return { kind: "no_date" };

  const deadline = addDays(hearingDay, SURENCHERE_WINDOW_DAYS);
  const expired = parisDateKey(now) > deadline;
  return { kind: "window", hearingDay, deadline, adjudicationConfirmed, expired };
}
