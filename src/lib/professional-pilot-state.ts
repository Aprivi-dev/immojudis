import { formatPrice } from "./format";
import { safeDocumentUrl } from "./documents";
import { buildCadastralAnalysis, formatCadastralReference } from "./cadastre-analysis";
import { listingDate, listingVisits } from "./sale-listing";
import { collectSaleDocuments } from "./sale-documents";
import { getSaleProcedure, saleVerificationLabel, stateSaleMethodLabel } from "./sale-procedure";
import type { AuctionSale } from "./types";
import type { PilotCheck, PilotDefinition, PilotFact, PilotMilestone } from "./professional-pilots";

/**
 * Build the domanial pilot from facts already present on the sale.
 *
 * The state source covers several disposal methods and does not provide a
 * common eligibility or filing rule. Unknown values therefore stay null so
 * the UI can ask the investor to confirm them in the official notice.
 */
export function buildStatePilot(sale: AuctionSale): PilotDefinition {
  const procedure = getSaleProcedure(sale);
  if (procedure.venueType !== "state") {
    throw new Error("Le pilote domanial ne peut être construit que pour une vente domaniale.");
  }
  const documents = collectSaleDocuments(sale);
  const officialSourceUrl = firstSafeUrl(
    procedure.procedure?.verification.facts.find((fact) => fact.key === "state_sale_method")
      ?.source_url,
    procedure.sources.find((source) => source.kind === "listing")?.url,
    sale.source_url,
  );
  const documentSourceUrl = firstSafeUrl(...documents.map((document) => document.url));
  const conditionsSourceUrl = firstSafeUrl(
    ...documents
      .filter((document) =>
        /cahier|condition|charge|dossier|consultation|r[eè]glement|notice|pr[eé]sentation/i.test(
          `${document.label ?? ""} ${document.type ?? ""} ${document.document_type ?? ""}`,
        ),
      )
      .map((document) => document.url),
  );
  const cadastralSourceUrl = firstSafeUrl(
    ...documents
      .filter((document) =>
        /cadastre|cadastral|parcelle|plan/i.test(
          `${document.label ?? ""} ${document.type ?? ""} ${document.document_type ?? ""}`,
        ),
      )
      .map((document) => document.url),
  );
  const cadastralAnalysis = buildCadastralAnalysis(sale);
  const explicitCadastralReferences = cadastralAnalysis.references
    .filter((reference) => reference.confidence !== "inferred")
    .map(formatCadastralReference);
  const methodFact = procedure.procedure?.verification.facts.find(
    (fact) => fact.key === "state_sale_method",
  );
  const methodKnown = procedure.stateSaleMethod !== "unknown";
  const deadline = sale.sale_date?.trim() ? listingDate(sale.sale_date) : null;
  const visits = listingVisits(sale);
  const documentLabels = documents
    .map((document) => document.label?.trim() || document.name?.trim())
    .filter((label): label is string => Boolean(label))
    .slice(0, 4);
  const documentsValue = documents.length
    ? `${documents.length} pièce${documents.length > 1 ? "s" : ""}${
        documentLabels.length ? ` · ${documentLabels.join(" · ")}` : ""
      }`
    : null;
  const verification = saleVerificationLabel(procedure.verificationStatus);

  const facts: PilotFact[] = [
    {
      label: "Mode de cession publié",
      value: methodKnown ? stateSaleMethodLabel(procedure) : null,
      sourceUrl: firstSafeUrl(methodFact?.source_url, officialSourceUrl),
      detail: methodKnown
        ? `${verification}. Le mode est repris de la qualification de la source.`
        : "À confirmer dans l'avis officiel ; l'origine domaniale ne suffit pas à déterminer le mode.",
    },
    {
      label: "Échéance publiée",
      value: deadline,
      sourceUrl: officialSourceUrl,
      detail: deadline
        ? "Date reprise de la fiche source ; vérifier l'heure, le fuseau et toute mise à jour."
        : "Aucune échéance exploitable n'est publiée dans les données collectées.",
    },
    {
      label: "Prix publié",
      value:
        sale.starting_price_eur != null && Number.isFinite(sale.starting_price_eur)
          ? formatPrice(sale.starting_price_eur)
          : null,
      sourceUrl: officialSourceUrl,
      detail:
        "Le libellé exact et les conditions financières doivent être relus dans l'annonce officielle.",
    },
    {
      label: "Pièces du dossier",
      value: documentsValue,
      sourceUrl: firstSafeUrl(conditionsSourceUrl, documentSourceUrl, officialSourceUrl),
      detail: documents.length
        ? "Liens collectés depuis la fiche ; vérifier la version et la complétude du dossier."
        : "Aucune pièce exploitable n'est rattachée à la fiche.",
    },
    {
      label: "Visites publiées",
      value: visits.length ? visits.join(" · ") : null,
      sourceUrl: officialSourceUrl,
      detail: visits.length
        ? "Modalités reprises de la source ; le caractère obligatoire reste à confirmer dans l'avis."
        : "Aucune visite exploitable n'est publiée dans les données collectées.",
    },
    {
      label: "Référence parcellaire publiée",
      value: explicitCadastralReferences.length ? explicitCadastralReferences.join(" · ") : null,
      sourceUrl: firstSafeUrl(cadastralSourceUrl, officialSourceUrl),
      detail: explicitCadastralReferences.length
        ? "Référence trouvée dans les éléments cadastraux rattachés à la source ; périmètre à rapprocher des pièces."
        : "Référence cadastrale non établie dans les données collectées.",
    },
  ];

  const milestones: PilotMilestone[] = [
    {
      label:
        procedure.stateSaleMethod === "adjudication"
          ? "Date d'adjudication annoncée"
          : "Date publiée à qualifier dans l'avis",
      date: deadline,
      sourceUrl: officialSourceUrl,
    },
    {
      label: "Visites publiées",
      date: visits.length ? visits.join(" · ") : null,
      sourceUrl: officialSourceUrl,
    },
  ];

  const checks: PilotCheck[] = [
    {
      id: "state-official-notice",
      label: "Relire l'avis officiel et confirmer qu'il est encore à jour",
      reason:
        "Le mode de cession, l'échéance et les pièces doivent être confirmés sur la publication officielle.",
      sourceUrl: officialSourceUrl,
    },
    {
      id: "state-sale-method",
      label: "Confirmer le mode de cession applicable au bien",
      reason:
        "Une vente domaniale peut relever de plusieurs modes ; la source doit être explicite.",
      sourceUrl: officialSourceUrl,
    },
    {
      id: "state-deadline",
      label: "Confirmer l'échéance exacte et la preuve attendue",
      reason: "La date publiée doit être rapprochée des instructions de remise ou de séance.",
      sourceUrl: officialSourceUrl,
    },
    {
      id: "state-conditions",
      label: "Obtenir et relire les conditions de vente ou le cahier des charges",
      reason:
        "Les conditions propres au bien et les pièces à fournir doivent être établies dans le dossier officiel.",
      sourceUrl: firstSafeUrl(conditionsSourceUrl, documentSourceUrl, officialSourceUrl),
    },
    {
      id: "state-visit",
      label: "Confirmer les visites et leur caractère obligatoire éventuel",
      reason:
        "Les modalités de visite sont spécifiques à l'annonce et doivent être vérifiées avant candidature.",
      sourceUrl: officialSourceUrl,
    },
    {
      id: "state-parcel",
      label: "Vérifier les parcelles incluses, leurs limites et leur surface",
      reason:
        "Le périmètre vendu doit être rapproché de la référence cadastrale et des pièces annexées.",
      sourceUrl: firstSafeUrl(cadastralSourceUrl, conditionsSourceUrl, officialSourceUrl),
    },
    {
      id: "state-urbanism",
      label: "Contrôler le zonage, les autorisations et l'usage possible",
      reason:
        "Le projet doit être confronté aux documents d'urbanisme et aux autorisations disponibles.",
      sourceUrl: firstSafeUrl(conditionsSourceUrl, documentSourceUrl, officialSourceUrl),
    },
    {
      id: "state-easements",
      label: "Vérifier servitudes, accès, occupation et charges mentionnés",
      reason:
        "Ces éléments peuvent modifier le périmètre ou la faisabilité et doivent être documentés.",
      sourceUrl: firstSafeUrl(conditionsSourceUrl, documentSourceUrl, officialSourceUrl),
    },
    {
      id: "state-eligibility",
      label: "Vérifier les conditions d'éligibilité publiées pour le candidat",
      reason:
        "La qualité du candidat, les garanties et les restrictions doivent être relevées dans l'avis ou le règlement officiel, sans être déduites du seul mode de cession.",
      sourceUrl: firstSafeUrl(conditionsSourceUrl, documentSourceUrl, officialSourceUrl),
    },
    {
      id: "state-submission",
      label: "Confirmer les pièces, la date et le canal de remise du dossier",
      reason:
        "Le dossier, son canal de remise et les preuves attendues sont propres à la publication et restent à confirmer dans les instructions officielles.",
      sourceUrl: officialSourceUrl,
    },
    {
      id: "state-financing",
      label: "Valider le budget complet et la disponibilité des fonds",
      reason:
        "Les hypothèses financières de l'investisseur doivent être séparées des faits publiés de la vente.",
      sourceUrl: officialSourceUrl,
    },
  ];

  return {
    kind: "state",
    title: "Bureau de candidature domaniale",
    description:
      "Qualifiez la cession, sécurisez les pièces et contrôlez le foncier avant de déposer une candidature.",
    priceLabel: "Prix proposé par vous",
    packetLabel: "Dossier de candidature domaniale",
    counterpartyLabel: "Service vendeur",
    counterparty: procedure.organizerName?.trim() || null,
    facts,
    milestones,
    checks,
  };
}

function firstSafeUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const url = safeDocumentUrl(value);
    if (url) return url;
  }
  return null;
}
