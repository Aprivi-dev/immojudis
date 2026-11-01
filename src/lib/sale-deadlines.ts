import { surenchereWindow } from "@/lib/surenchere-window";

/**
 * Échéancier INDICATIF d'une vente remportée (n° 94) : la fin du délai de surenchère et le paiement
 * du prix, datés à partir de l'audience.
 *
 * Ce n'est pas un calcul de délai de procédure. Il reprend les règles que le site cite déjà, et pas
 * davantage :
 * - surenchère : dix jours après l'audience (art. R. 322-50 du CPCE), calculés par
 *   `surenchereWindow` ; le report au premier jour ouvrable suivant (samedi, dimanche, jour férié,
 *   art. 641 et 642 du CPC) n'est PAS calculé ;
 * - paiement du prix : deux mois après l'adjudication définitive (art. R. 322-56), celle-ci devenant
 *   définitive à la fin du délai de surenchère « selon l'analyse usuelle » (point de départ à
 *   confirmer avec l'avocat, comme dans le dossier de financement).
 * Les deux dates sont donc des dates « au plus tôt », jamais des échéances fermes : elles ne tiennent
 * pas compte d'un report, d'une surenchère formée (nouvelle audience) ni d'une audience dont la date a
 * changé. Chaque date porte sa source et la mention « à confirmer avec votre avocat ».
 *
 * Réservé aux saisies immobilières : ces articles visent cette procédure. Pour une liquidation, un
 * partage (licitation), une vente notariale ou domaniale, d'autres délais s'appliquent : aucun
 * échéancier n'est produit.
 */

export const DEADLINES_CONFIRM_NOTICE = "À confirmer avec votre avocat.";

/** Délai de paiement du prix, en mois, après l'adjudication définitive (art. R. 322-56 du CPCE). */
export const PAYMENT_DELAY_MONTHS = 2;

export type SaleDeadline = {
  key: "surenchere" | "paiement";
  /** Jour indicatif, `AAAA-MM-JJ` (calendrier de Paris). */
  isoDay: string;
  /** Titre court, sans promesse : « au plus tôt ». */
  label: string;
  /** Règle et article cités. */
  source: string;
  /** Réserves propres à cette date. */
  caveat: string;
};

/** Vrai quand cet échéancier peut être produit pour cette vente. */
export function saleDeadlinesApply(args: {
  venueType: string | null | undefined;
  legalFramework: string | null | undefined;
}): boolean {
  return args.venueType === "tribunal" && args.legalFramework === "judicial_seizure";
}

function addMonthsClamped(isoDay: string, months: number): string {
  const [year, month, day] = isoDay.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Les deux dates indicatives, ou `null` quand l'échéancier ne s'applique pas (procédure autre qu'une
 * saisie immobilière) ou que l'audience n'a pas de date exploitable.
 */
export function saleDeadlines({
  saleDate,
  venueType,
  legalFramework,
  now = new Date(),
}: {
  saleDate: string | null | undefined;
  venueType: string | null | undefined;
  legalFramework: string | null | undefined;
  now?: Date;
}): SaleDeadline[] | null {
  if (!saleDeadlinesApply({ venueType, legalFramework })) return null;
  const window = surenchereWindow({ saleDate, venueType, adjudicationConfirmed: true, now });
  if (window.kind !== "window") return null;
  return [
    {
      key: "surenchere",
      isoDay: window.deadline,
      label: "Fin du délai de surenchère, au plus tôt",
      source: "Dix jours après l’audience (art. R. 322-50 du CPCE).",
      caveat:
        "Si ce jour est un samedi, un dimanche ou un jour férié, le délai est prolongé jusqu’au premier jour ouvrable suivant (art. 641 et 642 du CPC) : cette prolongation n’est pas calculée. Une surenchère entraîne une nouvelle audience.",
    },
    {
      key: "paiement",
      isoDay: addMonthsClamped(window.deadline, PAYMENT_DELAY_MONTHS),
      label: "Paiement du prix, au plus tôt",
      source:
        "Deux mois après l’adjudication définitive (art. R. 322-56 du CPCE), que nous retenons à la fin du délai de surenchère selon l’analyse usuelle ; frais de poursuite et droits de mutation en plus (art. R. 322-58).",
      caveat:
        "Le point de départ est à confirmer avec votre avocat ; la date se décale si le délai de surenchère est prolongé ou si une surenchère est formée.",
    },
  ];
}
