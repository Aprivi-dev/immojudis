import { occupancyLabel, propertyTypeLabel } from "@/lib/format";
import { collectSaleDocuments } from "@/lib/sale-documents";
import {
  getSaleProcedure,
  lawyerRequirementLabel,
  overbidLabel,
  participationModeLabel,
  paymentDeadlineLabel,
  saleLegalFrameworkLabel,
  saleProcedureIsConfirmed,
  saleVerificationLabel,
} from "@/lib/sale-procedure";
import { safeDocumentUrl } from "@/lib/documents";
import type { AuctionSale, SaleDocumentRich } from "@/lib/types";
import type {
  PilotCheck,
  PilotDefinition,
  PilotFact,
  PilotMilestone,
} from "@/lib/professional-pilots";

/**
 * Build the tribunal-only preparation brief used by the professional pilot.
 *
 * This builder deliberately exposes facts only when the underlying sale or
 * procedure has a safe source URL. A value that is present in the row but
 * cannot be traced to a usable source stays null and is rendered as a point to
 * confirm by the caller.
 */
export function buildTribunalPilot(sale: AuctionSale): PilotDefinition {
  const procedure = getSaleProcedure(sale);
  if (procedure.venueType !== "tribunal") {
    throw new Error("Le pilote tribunal ne peut être construit que pour une vente au tribunal.");
  }

  const documents = collectSaleDocuments(sale);
  const procedureSource = firstSafeUrl(
    ...(procedure.procedure?.verification.case_sources ?? [])
      .filter((source) => source.kind === "listing" || source.kind === "document")
      .map((source) => source.url),
    sale.source_url,
  );
  const listingSource = safeDocumentUrl(sale.source_url);
  const conditionsSource = documentSource(documents, /cahier|condition/i);
  const descriptiveReportSource = documentSource(documents, /pv|descriptif|huissier|constat/i);
  const diagnosticsSource = documentSource(documents, /diagnostic|dpe|amiante|plomb|termite/i);
  const occupationSource =
    riskSource(sale, /occupation|occupant|locataire|bail/) ??
    descriptiveReportSource ??
    conditionsSource ??
    listingSource;
  const procedureFacts = procedure.procedure?.verification.facts ?? [];
  const courtFact = procedureFacts.find((fact) => fact.key === "competent_court");
  const courtFactSource = safeDocumentUrl(courtFact?.source_url);
  const verifiedCourt =
    Boolean(courtFact) &&
    (courtFact?.status === "verified" || courtFact?.status === "cross_checked") &&
    hasText(courtFact?.value);
  const procedureConfirmed = saleProcedureIsConfirmed(procedure);
  // The parsed rule block can exist while its verification is still pending.
  // Keep those rules out of the brief until the procedure itself is confirmed.
  const explicitRules = procedureConfirmed ? procedure.procedure?.rules : null;
  const structuredSource = procedureSource ?? listingSource;
  const saleDate = listingSource ? validDateValue(sale.sale_date) : null;
  const visitMilestones = visitValues(sale.visit_dates).map<PilotMilestone>((visit) => ({
    label: "Créneau de visite publié",
    date: listingSource ? visit : null,
    sourceUrl: listingSource,
  }));

  const facts: PilotFact[] = [
    fact(
      "Type de vente",
      procedureConfirmed ? "Vente au tribunal" : null,
      structuredSource,
      `Qualification du dossier : ${saleVerificationLabel(procedure.verificationStatus)}.`,
    ),
    fact(
      "Tribunal compétent",
      verifiedCourt && procedureConfirmed
        ? (stringValue(courtFact?.value) ?? procedure.venueName)
        : (procedure.venueName ?? sale.tribunal_name ?? sale.tribunal),
      courtFactSource ?? structuredSource,
      verifiedCourt
        ? "Rattachement au tribunal confirmé par un fait de procédure."
        : "Rattachement à confirmer dans la pièce de la vente et le référentiel compétent.",
      { requireConfirmed: !verifiedCourt || !procedureConfirmed },
    ),
    fact(
      "Cadre juridique",
      procedure.legalFramework === "unknown"
        ? null
        : saleLegalFrameworkLabel(procedure.legalFramework),
      structuredSource,
      "Cadre à rapprocher des pièces de la vente avant décision.",
      { requireConfirmed: !procedureConfirmed },
    ),
    fact(
      "Mise à prix publiée",
      moneyValue(sale.starting_price_eur),
      listingSource,
      "Montant repris de l'annonce ; il ne constitue pas un plafond d'enchère.",
    ),
    fact(
      "Avocat / représentation",
      procedureConfirmed &&
        (explicitRules?.lawyer_required === true || explicitRules?.lawyer_required === false)
        ? lawyerRequirementLabel(procedure)
        : null,
      structuredSource,
      procedureConfirmed && procedure.eligibleBar
        ? `Barreau indiqué : ${procedure.eligibleBar}.`
        : "Représentation et barreau à confirmer dans les conditions de vente.",
      {
        detailValue: procedureConfirmed ? (procedure.organizerName ?? sale.lawyer_name) : null,
      },
    ),
    fact(
      "Consignation",
      explicitRules?.guarantee && hasExplicitGuarantee(explicitRules.guarantee)
        ? guaranteeValue(explicitRules.guarantee)
        : null,
      conditionsSource ?? structuredSource,
      "Montant, bénéficiaire et forme de remise à contrôler dans le cahier des conditions.",
    ),
    fact(
      "Délai de paiement",
      explicitRules?.payment_deadline_days != null
        ? paymentDeadlineLabel(explicitRules.payment_deadline_days)
        : null,
      conditionsSource ?? structuredSource,
      "Délai affiché seulement lorsqu'il est présent dans la procédure structurée.",
    ),
    fact(
      "Surenchère",
      explicitRules?.overbid && hasExplicitOverbid(explicitRules.overbid)
        ? overbidLabel(procedure)
        : null,
      conditionsSource ?? structuredSource,
      "Faculté, seuil et délai à vérifier dans le cahier des conditions.",
    ),
    fact(
      "Mode de participation",
      explicitRules && procedure.procedure?.participation_mode
        ? participationModeLabel(procedure.participationMode)
        : null,
      structuredSource,
      "Modalité issue de la procédure structurée de la vente.",
    ),
    fact(
      "Occupation",
      sale.occupancy_status ? occupancyLabel(sale.occupancy_status) : null,
      occupationSource,
      "Occupation à confirmer dans le PV descriptif, le cahier et lors de la visite.",
    ),
    fact(
      "Pièce centrale",
      conditionsSource ? "Cahier des conditions disponible" : null,
      conditionsSource,
      "Le cahier des conditions fixe les clauses, frais et modalités propres à la vente.",
    ),
    fact(
      "Bien",
      propertyTypeLabel(sale.property_type),
      listingSource,
      "Type repris de l'annonce ; caractéristiques et surfaces restent à relire dans les pièces.",
    ),
  ];

  const milestones: PilotMilestone[] = [
    {
      label: "Audience d'adjudication",
      date: saleDate,
      sourceUrl: listingSource,
    },
    ...visitMilestones,
  ];

  const checks: PilotCheck[] = [
    check(
      "tribunal_assignment",
      "Confirmer le tribunal compétent et le barreau avant de mandater un avocat.",
      "Le rattachement ne peut être considéré comme établi sans fait de compétence vérifié ou recoupé.",
      courtFactSource ?? structuredSource,
    ),
    check(
      "conditions_review",
      "Relire le cahier des conditions de vente, notamment frais, paiement et surenchère.",
      "Cette pièce fixe les conditions particulières de l'adjudication.",
      conditionsSource,
    ),
    check(
      "descriptive_report_review",
      "Relire le PV descriptif ou le constat sur l'état, l'accès et les équipements.",
      "Le PV descriptif porte les éléments matériels à rapprocher de la visite.",
      descriptiveReportSource,
    ),
    check(
      "occupation_confirmation",
      "Confirmer l'occupation, le bail éventuel et les conséquences sur la jouissance.",
      "L'occupation peut modifier le calendrier, les travaux et le risque d'exécution.",
      occupationSource,
    ),
    check(
      "consignation_confirmation",
      "Vérifier montant, bénéficiaire, forme et délai de remise de la consignation.",
      "Une consignation non confirmée bloque la préparation opérationnelle de l'audience.",
      conditionsSource ?? structuredSource,
    ),
    check(
      "diagnostics_review",
      "Relire les diagnostics disponibles et relever les travaux ou obligations associés.",
      "Les diagnostics peuvent modifier le coût complet et les hypothèses de travaux.",
      diagnosticsSource,
    ),
    check(
      "financing_confirmation",
      "Sécuriser le financement et les fonds mobilisables avant l'audience.",
      "Le financement doit être préparé avant une enchère ; aucune condition suspensive n'est présumée.",
      conditionsSource ?? structuredSource,
    ),
    check(
      "lawyer_brief",
      "Transmettre à l'avocat le plafond retenu, les hypothèses et les questions ouvertes.",
      "Le paquet de préparation doit distinguer faits sourcés, hypothèses et points à confirmer.",
      structuredSource,
    ),
    check(
      "last_document_check",
      "Effectuer un dernier contrôle des pièces et changements avant l'audience.",
      "Un document ajouté ou modifié peut changer les conditions de décision.",
      listingSource,
    ),
  ];

  return {
    kind: "tribunal",
    title: "Dossier de préparation d'audience",
    description:
      "Préparez une adjudication au tribunal à partir des faits publiés, des pièces disponibles et de vos hypothèses financières.",
    priceLabel: "Plafond d'enchère retenu",
    packetLabel: "Paquet avocat — adjudication tribunal",
    counterpartyLabel: "Avocat / barreau compétent",
    counterparty:
      procedureConfirmed && structuredSource
        ? (procedure.organizerName ?? sale.lawyer_name ?? procedure.eligibleBar ?? null)
        : null,
    facts,
    milestones,
    checks,
  };
}

function fact(
  label: string,
  value: string | null,
  sourceUrl: string | null,
  detail: string,
  options: { requireConfirmed?: boolean; detailValue?: string | null } = {},
): PilotFact {
  const sourcedValue = options.requireConfirmed || !sourceUrl ? null : value;
  const detailValue = options.detailValue?.trim();
  return {
    label,
    value: sourcedValue,
    sourceUrl,
    detail: !sourceUrl
      ? "À confirmer dans une pièce officielle de la vente."
      : detailValue
        ? `${detail} Interlocuteur indiqué : ${detailValue}.`
        : detail,
  };
}

function check(id: string, label: string, reason: string, sourceUrl: string | null): PilotCheck {
  return { id, label, reason, sourceUrl };
}

function documentSource(
  documents: Array<SaleDocumentRich & { name?: string }>,
  pattern: RegExp,
): string | null {
  return (
    documents.find((document) =>
      pattern.test(
        `${document.label ?? ""} ${document.type ?? ""} ${document.document_type ?? ""}`,
      ),
    )?.url ?? null
  );
}

function riskSource(sale: AuctionSale, pattern: RegExp): string | null {
  const occurrence = (sale.risks ?? [])
    .filter((risk) => pattern.test(`${risk.risk_type} ${risk.risk_label} ${risk.evidence ?? ""}`))
    .flatMap((risk) => risk.occurrences ?? [])
    .find((item) => safeDocumentUrl(item.document_url));
  return safeDocumentUrl(occurrence?.document_url);
}

function firstSafeUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const url = safeDocumentUrl(value);
    if (url) return url;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function moneyValue(value: number | null | undefined): string | null {
  return value != null && Number.isFinite(value)
    ? `${Math.round(value).toLocaleString("fr-FR")} €`
    : null;
}

function guaranteeValue(guarantee: {
  amount_eur: number | null;
  rate_pct: number | null;
  minimum_eur: number | null;
}): string | null {
  if (guarantee.amount_eur != null) return moneyValue(guarantee.amount_eur);
  if (guarantee.rate_pct != null) {
    const minimum =
      guarantee.minimum_eur != null ? ` · minimum ${moneyValue(guarantee.minimum_eur)}` : "";
    return `${guarantee.rate_pct} % de la mise à prix${minimum}`;
  }
  return null;
}

function hasExplicitGuarantee(value: {
  amount_eur: number | null;
  rate_pct: number | null;
  minimum_eur: number | null;
}): boolean {
  return value.amount_eur != null || value.rate_pct != null || value.minimum_eur != null;
}

function hasExplicitOverbid(value: {
  allowed: boolean | null;
  minimum_increase_pct: number | null;
  window_days: number | null;
}): boolean {
  return value.allowed != null || value.minimum_increase_pct != null || value.window_days != null;
}

function validDateValue(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function visitValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function hasText(value: unknown): boolean {
  return stringValue(value) !== null;
}
