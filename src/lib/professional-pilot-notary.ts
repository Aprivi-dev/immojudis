import { formatPrice, occupancyLabel, propertyTypeLabel } from "@/lib/format";
import { safeDocumentUrl } from "@/lib/documents";
import { collectSaleDocuments } from "@/lib/sale-documents";
import { listingDate, listingVisits } from "@/lib/sale-listing";
import {
  getSaleProcedure,
  guaranteeLabel,
  overbidLabel,
  participationModeLabel,
  paymentDeadlineLabel,
  saleLegalFrameworkLabel,
  saleVerificationLabel,
} from "@/lib/sale-procedure";
import { saleSession, saleWindow } from "@/lib/sale-window";
import type { AuctionSale } from "@/lib/types";
import type {
  PilotCheck,
  PilotDefinition,
  PilotFact,
  PilotMilestone,
} from "@/lib/professional-pilots";

/**
 * Build the notarial preparation brief used by the professional pilot.
 *
 * Notarial sales can be held in person or through an interactive online
 * session. The builder keeps the two schedules distinct and only surfaces a
 * payment, guarantee or overbid rule when the sale procedure or its source
 * blocks contains an explicit value.
 */
export function buildNotaryPilot(sale: AuctionSale): PilotDefinition {
  const procedure = getSaleProcedure(sale);
  if (procedure.venueType !== "notary") {
    throw new Error("Le pilote notarial ne peut être construit que pour une vente notariale.");
  }

  const documents = collectSaleDocuments(sale);
  const listingSource = safeDocumentUrl(sale.source_url);
  const procedureSource = firstSafeUrl(
    ...procedure.sources
      .filter((source) => source.kind === "listing" || source.kind === "document")
      .map((source) => source.url),
    listingSource,
  );
  const officialSource = procedureSource ?? listingSource;
  const conditionsSource = documentSource(
    documents,
    /cahier|charge|condition|r[eè]glement|vente[_ -]?notariale/i,
  );
  const diagnosticsSource = documentSource(documents, /diagnostic|dpe|amiante|plomb|termite/i);
  const occupancySource =
    riskSource(sale, /occupation|occupant|locataire|bail/) ?? conditionsSource ?? officialSource;
  const counterparty = knownText(procedure.organizerName);
  const operation = notarialOperation(sale);
  const guarantee = notarialGuarantee(sale, procedure);
  const payment = notarialPayment(sale, procedure);
  const overbid = notarialOverbid(sale, procedure);
  const documentsValue = documentsSummary(documents);
  const propertyType = knownText(sale.property_type) ? propertyTypeLabel(sale.property_type) : null;
  const occupancy = knownOccupancy(sale.occupancy_status)
    ? occupancyLabel(sale.occupancy_status)
    : null;
  const verification = saleVerificationLabel(procedure.verificationStatus);

  const facts: PilotFact[] = [
    {
      label: "Type de vente",
      value: "Vente notariale",
      sourceUrl: officialSource,
      detail: `Qualification du dossier : ${verification}.`,
    },
    {
      label: "Type d'opération",
      value: operation,
      sourceUrl: officialSource,
      detail:
        operation === "Vente notariale interactive"
          ? "La fenêtre d'enchères en ligne doit être respectée telle qu'elle est publiée."
          : "Le libellé et le déroulement de la vente doivent être rapprochés de l'annonce officielle.",
    },
    {
      label: "Office notarial",
      value: counterparty,
      sourceUrl: officialSource,
      detail: counterparty
        ? "Coordonnée reprise de la fiche ; vérifier l'interlocuteur et le canal de contact dans l'annonce."
        : "L'office organisateur n'est pas identifié dans les données collectées.",
    },
    {
      label: "Prix publié",
      value: moneyValue(sale.starting_price_eur),
      sourceUrl: listingSource ?? officialSource,
      detail: "Le prix affiché ne préjuge pas du prix final ni des frais propres au dossier.",
    },
    {
      label: "Mode de participation",
      value:
        procedure.participationMode === "unknown"
          ? null
          : participationModeLabel(procedure.participationMode),
      sourceUrl: officialSource,
      detail: "Le canal de participation doit être confirmé dans les instructions de la vente.",
    },
    {
      label: "Consignation",
      value: guarantee,
      sourceUrl: conditionsSource ?? officialSource,
      detail: "Montant, bénéficiaire et mode de remise restent à contrôler dans les conditions.",
    },
    {
      label: "Conditions de paiement",
      value: payment,
      sourceUrl: conditionsSource ?? officialSource,
      detail:
        "Aucun délai ni aucune condition ne sont déduits lorsqu'ils ne sont pas explicitement publiés.",
    },
    {
      label: "Surenchère éventuelle",
      value: overbid,
      sourceUrl: conditionsSource ?? officialSource,
      detail:
        "La faculté, le seuil et le délai éventuels doivent être relus dans le cahier des charges.",
    },
    {
      label: "Pièces du dossier",
      value: documentsValue,
      sourceUrl:
        conditionsSource ?? (documents.length ? (documents[0]?.url ?? null) : officialSource),
      detail: documents.length
        ? "La présence d'une pièce ne valide ni sa version ni son contenu."
        : "Aucune pièce exploitable n'est rattachée à la fiche.",
    },
    {
      label: "Occupation",
      value: occupancy,
      sourceUrl: occupancySource,
      detail: "Situation à rapprocher de la visite, des pièces et des conditions de la vente.",
    },
    {
      label: "Bien",
      value: propertyType,
      sourceUrl: listingSource ?? officialSource,
      detail:
        "Type repris de l'annonce ; surfaces, annexes et état restent à relire dans le dossier.",
    },
  ];

  const onlineWindow = saleWindow(sale);
  const saleSessionWindow = saleSession(sale);
  const schedule = onlineWindow ?? saleSessionWindow;
  const milestones: PilotMilestone[] = [
    {
      label: onlineWindow
        ? "Fenêtre d'enchères notariales en ligne"
        : saleSessionWindow
          ? "Séance notariale publiée"
          : "Date de la vente notariale",
      date: schedule
        ? `${listingDate(schedule.opens_at)} → ${listingDate(schedule.closes_at)}`
        : validDateValue(sale.sale_date)
          ? listingDate(sale.sale_date)
          : null,
      sourceUrl: listingSource ?? officialSource,
    },
    {
      label: "Visites publiées",
      date: listingVisits(sale).join(" · ") || null,
      sourceUrl: listingSource ?? officialSource,
    },
  ];

  const checks: PilotCheck[] = [
    check(
      "notary-official-source",
      "Relire l'annonce officielle et contrôler sa date de mise à jour.",
      "Le prix, le calendrier et les modalités peuvent évoluer sur la publication de l'office.",
      officialSource,
    ),
    check(
      "notary-operation",
      "Confirmer le type d'opération et le canal de participation auprès de l'office.",
      "Une vente notariale peut se dérouler en séance ou en ligne selon les instructions publiées.",
      officialSource,
    ),
    check(
      "notary-conditions",
      "Relire le cahier des charges et les conditions propres à cette vente.",
      "Cette pièce fixe les règles, frais, délais et pièces applicables au dossier.",
      conditionsSource ?? officialSource,
    ),
    check(
      "notary-guarantee",
      "Confirmer la consignation, son bénéficiaire et son mode de remise.",
      "Une consignation ne doit être préparée qu'à partir des instructions de la vente.",
      conditionsSource ?? officialSource,
    ),
    check(
      "notary-calendar",
      onlineWindow
        ? "Bloquer les heures d'ouverture et de clôture de la séance en ligne."
        : "Confirmer la date, l'heure et le lieu de la séance notariale.",
      "Le calendrier de l'annonce doit être rapproché des conditions et contrôlé avant toute offre.",
      listingSource ?? officialSource,
    ),
    check(
      "notary-visit",
      "Effectuer ou documenter la visite du bien et ses limites.",
      "La visite permet de confronter l'état, l'accès, les surfaces et les annexes aux pièces.",
      listingSource ?? officialSource,
    ),
    check(
      "notary-occupancy",
      "Confirmer l'occupation, le bail éventuel et la jouissance du bien.",
      "La situation d'occupation peut modifier le calendrier, le risque et les hypothèses de sortie.",
      occupancySource,
    ),
    check(
      "notary-diagnostics",
      "Relire les diagnostics disponibles et relever les travaux associés.",
      "Les diagnostics et la visite doivent alimenter le coût complet de l'opération.",
      diagnosticsSource ?? conditionsSource ?? officialSource,
    ),
    check(
      "notary-financing",
      "Valider le financement et les fonds mobilisables avant de faire une offre.",
      "Les hypothèses de financement restent celles de l'investisseur ; aucune condition n'est présumée.",
      conditionsSource ?? officialSource,
    ),
    check(
      "notary-questions",
      "Préparer les questions ouvertes et les transmettre à l'office.",
      "Le dossier exporté doit séparer les faits publiés, les hypothèses et les points à confirmer.",
      officialSource,
    ),
  ];

  return {
    kind: "notary",
    title: "Bureau d'offre notariale",
    description:
      "Préparez une offre notariale à partir des conditions publiées, des pièces disponibles et de vos hypothèses financières.",
    priceLabel: "Prix ou offre envisagée",
    packetLabel: "Dossier de décision — vente notariale",
    counterpartyLabel: "Office notarial",
    counterparty,
    facts,
    milestones,
    checks,
  };
}

function check(id: string, label: string, reason: string, sourceUrl: string | null): PilotCheck {
  return { id, label, reason, sourceUrl };
}

function documentSource(
  documents: ReturnType<typeof collectSaleDocuments>,
  pattern: RegExp,
): string | null {
  const document = documents.find((candidate) =>
    pattern.test(
      `${candidate.label ?? ""} ${candidate.name ?? ""} ${candidate.type ?? ""} ${candidate.document_type ?? ""}`,
    ),
  );
  return safeDocumentUrl(document?.url);
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

function knownText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const valueText = value.trim();
  const normalized = valueText
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("fr-FR");
  const comparable = normalized.replace(/[.!?]+$/, "").trim();
  if (
    [
      "unknown",
      "inconnu",
      "a confirmer",
      "a verifier",
      "non renseigne",
      "non communique",
      "n/a",
      "null",
      "-",
      "—",
    ].includes(comparable)
  )
    return null;
  return valueText;
}

function knownOccupancy(value: string | null): boolean {
  const text = knownText(value);
  return text !== null && text.toLocaleLowerCase("fr-FR") !== "à confirmer";
}

function notarialOperation(sale: AuctionSale): string | null {
  const transaction = knownText(sourceBlock(sale, "type_transaction"))?.toUpperCase();
  if (transaction === "VNI") return "Vente notariale interactive";
  if (transaction === "VAE") return "Vente aux enchères notariale";
  const mode = knownText(sourceBlock(sale, "mode_vente"));
  if (mode) return mode;
  const framework = getSaleProcedure(sale).legalFramework;
  return framework === "unknown" ? null : saleLegalFrameworkLabel(framework);
}

function notarialGuarantee(
  sale: AuctionSale,
  procedure: ReturnType<typeof getSaleProcedure>,
): string | null {
  const raw = knownText(sourceBlock(sale, "consignation"));
  if (raw) return raw;
  const rules = procedure.procedure?.rules?.guarantee;
  if (
    procedure.guaranteeAmountEur != null ||
    procedure.guaranteeRatePct != null ||
    procedure.guaranteeMinimumEur != null
  ) {
    return guaranteeLabel(procedure);
  }
  if (rules && (rules.amount_eur != null || rules.rate_pct != null || rules.minimum_eur != null)) {
    return guaranteeLabel(procedure);
  }
  return null;
}

function notarialPayment(
  sale: AuctionSale,
  procedure: ReturnType<typeof getSaleProcedure>,
): string | null {
  const sourceValue = knownText(sourceBlock(sale, "seance_paiement"));
  if (sourceValue) return sourceValue;
  return procedure.paymentDeadlineDays == null
    ? null
    : paymentDeadlineLabel(procedure.paymentDeadlineDays);
}

function notarialOverbid(
  sale: AuctionSale,
  procedure: ReturnType<typeof getSaleProcedure>,
): string | null {
  const sourceValue = knownText(sourceBlock(sale, "surenchere"));
  if (sourceValue) return sourceValue;
  const hasRule =
    procedure.overbidAllowed != null ||
    procedure.overbidMinimumIncreasePct != null ||
    procedure.overbidWindowDays != null;
  return hasRule ? overbidLabel(procedure) : null;
}

function sourceBlock(sale: AuctionSale, key: string): unknown {
  return sale.source_blocks?.[key];
}

function moneyValue(value: number | null | undefined): string | null {
  return value != null && Number.isFinite(value) && value >= 0 ? formatPrice(value) : null;
}

function documentsSummary(documents: ReturnType<typeof collectSaleDocuments>): string | null {
  if (!documents.length) return null;
  const labels = documents
    .map((document) => document.label?.trim() || document.name?.trim())
    .filter((label): label is string => Boolean(label))
    .slice(0, 4);
  return `${documents.length} pièce${documents.length > 1 ? "s" : ""}${labels.length ? ` · ${labels.join(" · ")}` : ""}`;
}

function validDateValue(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}
