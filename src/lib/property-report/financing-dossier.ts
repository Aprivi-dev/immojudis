import { CONSIGNATION_MINIMUM, CONSIGNATION_RATE } from "@/lib/bid-ceiling-engine";
import { formatDate, formatPrice } from "@/lib/format";
import { numberValue, stringOrNumberValue } from "@/lib/guards";
import { reportSaleSchedule } from "@/lib/report-sale-schedule";
import { PDF_PAGE_BREAK } from "@/lib/simple-pdf";

/**
 * Page « Dossier de financement » du rapport PDF : de quoi montrer à un banquier ou à un courtier
 * la mise à prix, l'enchère plafond simulée, les frais estimés, la garantie à remettre avant les
 * enchères, le délai de paiement et les pièces utiles. Toutes les valeurs viennent du rapport déjà
 * enregistré (rien n'est recalculé, hormis la garantie de 10 % que la règle fixe sur la mise à
 * prix) ; une valeur absente s'affiche « non renseigné ».
 *
 * Les règles citées sont celles de l'article de /ressources « Garantie de 10 % : chèque de banque ou
 * caution ? » (CPCE, art. R. 322-41, R. 322-56, R. 322-58). Elles visent les ventes au tribunal
 * (saisie immobilière, licitation) ; pour un autre type de vente, la page renvoie à l'annonce et à
 * l'organisateur au lieu d'appliquer une règle qui n'est pas la leur.
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

  const tribunalRules = tribunal || venue == null || venue === "unknown";
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
    `Type de vente: ${venueLabel ?? `${FINANCING_NOT_PROVIDED} (règles ci-dessous : vente au tribunal)`} ; tribunal: ${text(sale.tribunal)}`,
    ...schedule,
    "",
    "Chiffres du dossier",
    `Mise à prix: ${euros(startingPrice)}`,
    `Enchère plafond (simulation): ${euros(ceilingBid)}${
      ceilingBid == null ? "" : " (hypothèses d’Immojudis, pas un budget validé)"
    }`,
    `Frais estimés hors travaux: ${euros(fees)}${
      fees == null
        ? ""
        : " (estimation par défaut : émoluments, droits de mutation, frais de poursuite, honoraires d’avocat)"
    }`,
    "",
    "Garantie à remettre avant les enchères",
    ...(tribunalRules
      ? [
          `Garantie de 10 % de la mise à prix, minimum 3 000 € (vente au tribunal): ${euros(guarantee)}`,
          `Montant indiqué dans l’annonce: ${euros(announcedGuarantee.amountEur)}`,
          "Forme: chèque de banque à l’ordre du séquestre ou de la Caisse des dépôts et consignations (selon le cahier), ou caution bancaire irrévocable (art. R. 322-41 du CPCE).",
          "Calculée sur la mise à prix, non sur l’enchère. Restituée à l’issue de l’audience si vous n’êtes pas adjudicataire ; acquise aux créanciers si l’adjudicataire est défaillant.",
        ]
      : [
          `Garantie de 10 % de la mise à prix, minimum 3 000 €: ne vise que les ventes au tribunal (${venueLabel ?? FINANCING_NOT_PROVIDED}).`,
          `Montant indiqué dans l’annonce: ${euros(announcedGuarantee.amountEur)}`,
          "Montant, forme et restitution: à lire dans l’annonce et à demander à l’organisateur de la vente.",
        ]),
    "",
    "Paiement du prix",
    ...(tribunalRules
      ? [
          "Délai: deux mois après l’adjudication définitive (suite du délai de surenchère) pour verser le prix au séquestre ou le consigner, à peine de réitération des enchères (art. R. 322-56).",
          "Frais de poursuite taxés et droits de mutation en plus du prix (art. R. 322-58).",
          "Imputation de la garantie sur le prix: non précisée par les textes, à demander à l’avocat.",
        ]
      : [
          `Délai: ${FINANCING_NOT_PROVIDED}. Le délai de deux mois vise les ventes au tribunal ; pour cette vente, il est fixé par l’annonce ou le cahier des conditions de vente.`,
        ]),
    "",
    "Documents utiles à la banque",
    `- Annonce et cahier des conditions de vente (pièces repérées par Immojudis: ${
      documents == null ? FINANCING_NOT_PROVIDED : String(documents)
    }).`,
    "- Le présent dossier (mise à prix, enchère plafond simulée, frais estimés).",
    "- Pièces habituelles d’un crédit (identité, revenus, impôts, comptes): selon votre banque.",
    "- Achat par une société ou à plusieurs: prévenir banque et avocat dès le départ.",
    "- À demander à la banque: accord avant l’audience, chèque de banque ou caution irrévocable (délai, coût, contrepartie), financement du solde sous deux mois.",
    "",
    "Règles du Code des procédures civiles d’exécution pour les ventes au tribunal ; leur application dépend du cahier des conditions de vente : à vérifier avec votre avocat.",
  ];
}
