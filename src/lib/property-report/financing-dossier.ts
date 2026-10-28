import { CONSIGNATION_MINIMUM, CONSIGNATION_RATE } from "@/lib/bid-ceiling-engine";
import { formatDate, formatPrice } from "@/lib/format";
import { numberValue, stringOrNumberValue } from "@/lib/guards";
import { reportSaleSchedule } from "@/lib/report-sale-schedule";
import { PDF_PAGE_BREAK } from "@/lib/simple-pdf";
import { reportWording } from "./report-wording";

/**
 * Page « Dossier de financement » du rapport PDF : de quoi montrer à un banquier ou à un courtier
 * la mise à prix, l'enchère plafond simulée, les frais estimés, la garantie à remettre avant les
 * enchères, le délai de paiement et les pièces utiles. Toutes les valeurs viennent du rapport déjà
 * enregistré (rien n'est recalculé, hormis la garantie de 10 % que la règle fixe sur la mise à
 * prix) ; une valeur absente s'affiche « non renseigné ».
 *
 * Les règles citées sont celles de l'article de /ressources « Garantie de 10 % : chèque de banque ou
 * caution ? » (CPCE, art. R. 322-41, R. 322-56, R. 322-58). Elles visent les ventes au tribunal
 * (saisie immobilière, licitation) ; en liquidation judiciaire, ces articles ne s'appliquent pas
 * tels quels : le Code de commerce renvoie aux seules règles de la vente forcée qu'il énumère
 * (art. L. 642-18 et R. 642-29-2) et règle lui-même le paiement du prix (art. R. 643-3), donc la
 * page cite le Code de commerce et n'y reprend ni R. 322-56 ni R. 322-58 ; pour un autre type de
 * vente, la page renvoie à l'annonce et à l'organisateur au lieu d'appliquer une règle qui n'est
 * pas la leur. Il en va de même quand le type
 * de vente est inconnu ou que les sources se contredisent (contrôle « conflict ») : la garantie et
 * le délai s'affichent « non renseigné » et renvoient à l'annonce.
 *
 * Le délai de paiement dépend du cadre juridique de la vente (`legalFramework`, voir
 * `sale-procedure.ts`) : deux mois en saisie immobilière, trois mois en liquidation judiciaire
 * (art. R. 643-3 du Code de commerce) ; pour un autre cadre, ou un cadre inconnu, il n'est pas
 * affiché comme acquis. Textes de la relecture juridique du 20/10/2026, à faire valider par un
 * avocat. La page tient sur 42 lignes (`paginatePdfLines`) : un test vérifie chaque cadre.
 */
export const FINANCING_NOT_PROVIDED = "non renseigné";

export const FINANCING_DOSSIER_TITLE = "Dossier de financement";

/** Intertitres de la page, mis en gras par le générateur de PDF. */
export const FINANCING_DOSSIER_HEADINGS = [
  FINANCING_DOSSIER_TITLE,
  "Le bien et la vente",
  "Chiffres du dossier",
  "Garantie à remettre avant les enchères",
  "Paiement du prix",
  "Documents utiles à la banque",
] as const;

const VENUE_LABELS: Record<string, string> = {
  tribunal: "vente au tribunal",
  notary: "vente chez le notaire",
  state: "cession de l’État",
  online: "vente en ligne",
};

export type FinancingDossierInput = {
  title: string;
  generatedAt: string | null;
  /** `snapshot.sale` du rapport. */
  sale: Record<string, unknown>;
  /** `ceiling_snapshot` du rapport. */
  ceiling: Record<string, unknown>;
  /** `snapshot.analysis.opportunity.acquisitionCosts`. */
  acquisitionCosts: Record<string, unknown>;
  /** `snapshot.analysis.auctionCostAnalysis.consignation` : le montant indiqué dans l'annonce. */
  announcedGuarantee: Record<string, unknown>;
  /** `snapshot.analysis.documentsCount`. */
  documentsCount: unknown;
};

function positive(value: unknown): number | null {
  const number = numberValue(value);
  return number != null && number > 0 ? number : null;
}

function euros(value: unknown): string {
  const number = positive(value);
  return number == null ? FINANCING_NOT_PROVIDED : formatPrice(number);
}

function text(value: unknown, ignored: readonly string[] = []): string {
  const clean = stringOrNumberValue(value, "").trim();
  return clean && !ignored.includes(clean) ? clean : FINANCING_NOT_PROVIDED;
}

/** Garantie de l'article R. 322-41 : 10 % de la mise à prix, jamais moins de 3 000 €. */
export function financingGuaranteeEur(startingPrice: unknown): number | null {
  const price = positive(startingPrice);
  return price == null
    ? null
    : Math.max(CONSIGNATION_MINIMUM, Math.round(price * CONSIGNATION_RATE));
}

export function financingDossierLines(input: FinancingDossierInput): string[] {
  const { sale, ceiling, acquisitionCosts, announcedGuarantee } = input;
  // Vocabulaire du régime du plafond (mise à prix ou première offre possible, frais couverts).
  const wording = reportWording(ceiling.regime);
  const startingPrice = positive(sale.startingPrice);
  const venue = typeof sale.venueType === "string" ? sale.venueType : null;
  const venueLabel = venue ? (VENUE_LABELS[venue] ?? null) : null;
  const tribunal = venue === "tribunal";
  const location =
    text(sale.displayAddress) !== FINANCING_NOT_PROVIDED
      ? text(sale.displayAddress)
      : [sale.address, sale.city, sale.department]
          .map((part) => stringOrNumberValue(part, "").trim())
          .filter(Boolean)
          .join(", ") || FINANCING_NOT_PROVIDED;
  const schedule = reportSaleSchedule(sale).map(
    ({ label, value }) =>
      `${label}: ${value === "Date non renseignée" ? FINANCING_NOT_PROVIDED : value}`,
  );
  const ceilingBid =
    ceiling.available === true && positive(ceiling.maxBid) != null ? ceiling.maxBid : null;
  // Sans mise à prix, les frais ne reposent sur aucun prix : ils ne sont pas annoncés.
  const fees = startingPrice == null ? null : positive(acquisitionCosts.acquisitionFeesTotal);
  const guarantee = financingGuaranteeEur(startingPrice);
  const documents = positive(input.documentsCount);

  // Type de vente inconnu ou en conflit entre les sources : aucune règle du tribunal n'est appliquée.
  const venueUncertain =
    venue == null || venue === "unknown" || sale.venueVerificationStatus === "conflict";
  const tribunalRules = tribunal && !venueUncertain;
  // Cadre juridique de la vente (`sale-procedure.ts`) : le délai de paiement en dépend. Un cadre
  // absent (rapport antérieur) ou inconnu n'est jamais traité comme une saisie immobilière.
  const legalFramework = typeof sale.legalFramework === "string" ? sale.legalFramework : null;
  const insolvency = tribunalRules && legalFramework === "insolvency";
  const seizure = tribunalRules && legalFramework === "judicial_seizure";
  return [
    PDF_PAGE_BREAK,
    FINANCING_DOSSIER_TITLE,
    `Synthèse à remettre à votre banque ou à votre courtier${
      input.generatedAt ? `, établie le ${formatDate(input.generatedAt)}` : ""
    }. Document indicatif d’Immojudis : ni offre de prêt, ni attestation, ni conseil.`,
    "",
    "Le bien et la vente",
    `Bien: ${text(input.title)}`,
    `Localisation: ${location}`,
    `Type: ${text(sale.propertyType, ["Bien", "Bien à qualifier"])} ; surface: ${
      positive(sale.surface) != null ? text(sale.surfaceLabel) : FINANCING_NOT_PROVIDED
    }`,
    `Type de vente: ${
      venueUncertain
        ? `${FINANCING_NOT_PROVIDED} (inconnu ou sources en désaccord : garantie et délai à lire dans l’annonce)`
        : (venueLabel ?? FINANCING_NOT_PROVIDED)
    } ; ${wording.venueLabel.toLowerCase()}: ${text(sale.tribunal)}`,
    ...schedule,
    "",
    "Chiffres du dossier",
    `${wording.referencePrice}: ${euros(startingPrice)}`,
    `${typeof ceiling.label === "string" ? ceiling.label : wording.ceilingLabel}: ${euros(ceilingBid)}${
      ceilingBid == null ? "" : " (hypothèses d’Immojudis, pas un budget validé)"
    }`,
    `Frais estimés hors travaux: ${euros(fees)}${
      fees == null ? "" : ` (estimation par défaut : ${wording.feesCoverage})`
    }`,
    "",
    wording.guaranteeHeading,
    ...(tribunalRules
      ? [
          `Garantie de 10 % de la mise à prix, minimum 3 000 € (vente au tribunal): ${euros(guarantee)}`,
          `Montant indiqué dans l’annonce: ${euros(announcedGuarantee.amountEur)}`,
          ...(insolvency
            ? [
                "Forme: chèque de banque ou caution bancaire irrévocable (art. R. 642-29-2 du Code de commerce, renvoi à R. 322-41 du CPCE).",
                "Bénéficiaire du chèque: à lire dans le cahier des conditions de vente.",
              ]
            : [
                "Forme: chèque de banque à l’ordre du séquestre (tiers qui garde les fonds) ou de la Caisse des dépôts (selon le cahier), ou caution bancaire irrévocable (art. R. 322-41 du CPCE).",
              ]),
          "Sur la mise à prix, non sur l’enchère. Restituée à l’issue de l’audience si vous n’êtes pas adjudicataire ; acquise aux créanciers et, le cas échéant, au débiteur si l’adjudicataire est défaillant ; la différence avec le prix de revente peut en plus être due.",
        ]
      : [
          venueUncertain
            ? `Garantie de 10 % de la mise à prix, minimum 3 000 €: ${FINANCING_NOT_PROVIDED} (le type de vente n’est pas établi ; cette règle ne vise que les ventes au tribunal).`
            : `Garantie de 10 % de la mise à prix, minimum 3 000 €: ne vise que les ventes au tribunal (${venueLabel ?? FINANCING_NOT_PROVIDED}).`,
          `Montant indiqué dans l’annonce: ${euros(announcedGuarantee.amountEur)}`,
          "Montant, forme et restitution: à lire dans l’annonce et à demander à l’organisateur de la vente.",
        ]),
    "",
    "Paiement du prix",
    ...(tribunalRules
      ? [
          insolvency
            ? "Délai: trois mois après l’adjudication, sur le compte ouvert par le liquidateur à la Caisse des dépôts, avec intérêts au taux légal (art. R. 643-3 du Code de commerce)."
            : seizure
              ? "Délai: deux mois après l’adjudication définitive (l’adjudication devient définitive à la fin du délai de surenchère, selon l’analyse usuelle : point de départ à confirmer avec l’avocat) pour verser le prix ou le consigner, à peine de réitération des enchères (art. R. 322-56)."
              : `Délai: ${FINANCING_NOT_PROVIDED} (cadre juridique de la vente non établi). Deux mois après l’adjudication définitive pour une saisie immobilière (art. R. 322-56) ; autre délai possible dans les autres cas : à lire dans le cahier des conditions de vente.`,
          insolvency
            ? "Frais de poursuite taxés en plus du prix, selon le cahier (à confirmer avec l’avocat)."
            : "Frais de poursuite taxés et droits de mutation en plus du prix (art. R. 322-58).",
          "Imputation de la garantie sur le prix: non précisée par les textes, à demander à l’avocat.",
        ]
      : [
          venueUncertain
            ? `Délai: ${FINANCING_NOT_PROVIDED}. Le type de vente n’étant pas établi, le délai de deux mois des ventes au tribunal n’est pas appliqué ; il est fixé par l’annonce ou le cahier des conditions de vente.`
            : `Délai: ${FINANCING_NOT_PROVIDED}. Le délai de deux mois vise les ventes au tribunal ; pour cette vente, il est fixé par l’annonce ou le cahier des conditions de vente.`,
        ]),
    "",
    "Documents utiles à la banque",
    `- Annonce et cahier des conditions de vente (pièces repérées par Immojudis: ${
      documents == null ? FINANCING_NOT_PROVIDED : String(documents)
    }).`,
    "- Pièces habituelles d’un crédit (identité, revenus, impôts, comptes): selon votre banque.",
    "- Achat par une société ou à plusieurs: prévenir banque et avocat dès le départ.",
    `- À demander à la banque: accord ${wording.beforeHearing}, chèque de banque ou caution irrévocable (délai, coût, contrepartie), financement du solde dans le délai de paiement du prix (deux mois pour une vente au tribunal en saisie immobilière ; à vérifier dans les autres cas).`,
    "",
    "Règles du Code des procédures civiles d’exécution pour les ventes au tribunal ; leur application dépend du cahier des conditions de vente : à vérifier avec votre avocat.",
  ];
}
