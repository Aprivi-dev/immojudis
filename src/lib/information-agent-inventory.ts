/**
 * Inventaire d'une fiche pour l'agent d'information : ce que l'on sait déjà et ce qui manque.
 *
 * Fonction pure, sans accès réseau. Elle lit toutes les données déjà extraites des sources —
 * champs de la vente, `source_blocks` (dont `caracteristiques_bien` et
 * `listing_completeness.source_property_features`), pièces `auction_documents`, signaux tirés des
 * PDF par le pipeline — afin que l'e-mail ne demande jamais une information déjà disponible.
 *
 * Règle : une valeur publiée par une source compte comme « disponible », même si aucune preuve
 * n'est encore rattachée (elle se vérifie dans la revue des faits, pas auprès du contact). Seules
 * sont demandées les informations absentes, contradictoires ou estimées.
 */
import { parseDocs } from "@/lib/documents";
import type { FactReliability, FactReliabilityMap } from "@/lib/fact-reliability";
import { asRecordOrNull } from "@/lib/guards";
import { publishedDay } from "@/lib/listing-evidence";
import { propertyImages } from "@/lib/sale-media";
import { getSaleProcedure } from "@/lib/sale-procedure";
import { getSaleSurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";

/** Signaux internes calculés par le chargeur admin à partir de `raw_payload` (jamais envoyés bruts). */
export type InformationAgentInventorySignals = {
  /** Faits candidats extraits des PDF par le pipeline, avec la pièce d'origine (sans extrait). */
  pdfFacts?: Partial<
    Record<
      "occupancy" | "rooms" | "surface" | "land_surface" | "energy",
      { documentLabel: string | null; documentType: string | null; page: number | null }
    >
  >;
  /** Classes énergétiques publiées par la source (`source_energy_diagnostics`). */
  energyClasses?: { dpe: string | null; ges: string | null } | null;
  /** Désignation cadastrale résolue par le pipeline (`cadastre_location`). */
  cadastre?: string | null;
  /** Un contact de visite est publié (`visit_contact`). */
  visitContact?: boolean;
};

export type InformationAgentInventorySale = AuctionSale & {
  information_agent_signals?: InformationAgentInventorySignals | null;
};

export type InformationAgentInventoryKey =
  | "hearing"
  | "venue"
  | "starting_price"
  | "surface"
  | "occupancy"
  | "visits"
  | "photos"
  | "sale_conditions"
  | "pv_descriptif"
  | "diagnostics"
  | "cadastre"
  | "composition"
  | "sale_terms";

export type InformationAgentInventoryStatus =
  | "present"
  | "to_confirm"
  | "missing"
  | "not_applicable";

/** Pièces que la question « documents » peut énumérer. */
export type InformationAgentMissingDocument = "sale_conditions" | "pv_descriptif" | "diagnostics";

export type InformationAgentInventoryItem = {
  key: InformationAgentInventoryKey;
  label: string;
  status: InformationAgentInventoryStatus;
  /** Valeur résumée ou motif du manque, sans donnée personnelle. */
  detail: string;
  /** Origine de l'information disponible (« annonce », « pièce : PV descriptif »…). */
  origin: string | null;
};

export type InformationAgentInventory = {
  /** Vente judiciaire (audience au tribunal, PV descriptif attendu). */
  judicial: boolean;
  items: InformationAgentInventoryItem[];
  missingDocuments: InformationAgentMissingDocument[];
};

const LABELS: Record<InformationAgentInventoryKey, string> = {
  hearing: "Date d’audience ou date limite",
  venue: "Lieu de la vente",
  starting_price: "Mise à prix",
  surface: "Surface",
  occupancy: "Occupation",
  visits: "Visites",
  photos: "Photos",
  sale_conditions: "Cahier des conditions de vente",
  pv_descriptif: "Procès-verbal descriptif",
  diagnostics: "Diagnostics techniques",
  cadastre: "Références cadastrales",
  composition: "Composition (pièces)",
  sale_terms: "Modalités de vente",
};

const DOCUMENT_PATTERNS: Record<InformationAgentMissingDocument | "cadastre", RegExp> = {
  sale_conditions:
    /(?:cahier|\bccv\b|conditions?[\s_-]*(?:de[\s_-]*)?(?:la[\s_-]*)?vente|sale[\s_-]*conditions)/i,
  pv_descriptif:
    /(?:\bpv[\s_-]*(?:huissier|descriptif|description|de[\s_-]*description|notaire)\b|\bpvd\b|proc[eè]s[\s_-]*verbal|pv_huissier|pv_notaire|constat)/i,
  diagnostics:
    /(?:diagnostic|\bdpe\b|\bddt\b|performance[\s_.-]*[ée]nerg|amiante|termites|\bplomb\b|\berp\b|\bdtg\b)/i,
  cadastre: /(?:cadastr)/i,
};

const PHOTO_TARGET = 4;

/** Inventaire complet de la fiche ; `facts` vient des preuves (fact claims) quand elles existent. */
export function buildInformationAgentInventory(
  sale: InformationAgentInventorySale,
  facts: FactReliabilityMap,
): InformationAgentInventory {
  const blocks = asRecordOrNull(sale.source_blocks) ?? {};
  const characteristics = asRecordOrNull(blocks.caracteristiques_bien);
  const features = asRecordOrNull(
    asRecordOrNull(blocks.listing_completeness)?.source_property_features,
  );
  const signals = sale.information_agent_signals ?? {};
  const procedureBlock = asRecordOrNull(characteristics?.procedure);
  const judicial = isJudicialSale(sale);
  const documents = documentLabels(sale, blocks, characteristics);
  const propertyType = (sale.property_type ?? "").toLowerCase();
  const withoutBuilding = propertyType === "land" || propertyType === "parking";

  const items: InformationAgentInventoryItem[] = [
    hearingItem(sale, facts.sale_date, procedureBlock, judicial),
    venueItem(sale, procedureBlock, judicial),
    startingPriceItem(sale, facts.starting_price_eur, procedureBlock),
    surfaceItem(sale, facts.surface, characteristics, signals, propertyType),
    occupancyItem(sale, facts.occupancy_status, features, blocks, signals),
    visitsItem(sale, blocks, procedureBlock, signals),
    photosItem(sale, characteristics),
    documentItem("sale_conditions", documents, true),
    documentItem("pv_descriptif", documents, judicial),
    diagnosticsItem(documents, characteristics, features, signals, withoutBuilding),
    cadastreItem(documents, blocks, characteristics, signals),
    compositionItem(sale, features, signals, withoutBuilding),
    saleTermsItem(sale, documents),
  ];

  const missingDocuments = (["sale_conditions", "pv_descriptif", "diagnostics"] as const).filter(
    (key) => items.find((item) => item.key === key)?.status === "missing",
  );
  return { judicial, items, missingDocuments };
}

export function isJudicialSale(sale: AuctionSale): boolean {
  const venue = (sale.sale_venue_type ?? "").toLowerCase();
  if (venue === "tribunal") return true;
  if (venue === "state" || venue === "notary" || venue === "online") return false;
  const source = (sale.source_name ?? sale.primary_source ?? "").toLowerCase();
  if (source === "cessions_etat" || source === "notaires") return false;
  return Boolean(sale.tribunal?.trim());
}

function item(
  key: InformationAgentInventoryKey,
  status: InformationAgentInventoryStatus,
  detail: string,
  origin: string | null = null,
): InformationAgentInventoryItem {
  return { key, label: LABELS[key], status, detail, origin };
}

/** Statut d'un fait clé : contradiction ou estimation = à confirmer ; une valeur publiée suffit. */
function keyFactStatus(
  fact: FactReliability | undefined,
  hasValue: boolean,
): { status: InformationAgentInventoryStatus; reason: string | null } {
  if (fact?.status === "conflict") {
    return { status: "to_confirm", reason: "Les sources se contredisent." };
  }
  if (!hasValue) return { status: "missing", reason: null };
  if (fact?.status === "inferred") {
    return { status: "to_confirm", reason: "Valeur estimée, à confirmer." };
  }
  if (fact?.reasonCode === "confirmation_reservation") {
    return { status: "to_confirm", reason: "La source signale une réserve sur cette valeur." };
  }
  return { status: "present", reason: null };
}

function sourceOrigin(sale: AuctionSale): string {
  const source = sale.source_name ?? sale.primary_source;
  return source ? `Annonce (${source})` : "Annonce";
}

function hearingItem(
  sale: AuctionSale,
  fact: FactReliability | undefined,
  procedure: Record<string, unknown> | null,
  judicial: boolean,
): InformationAgentInventoryItem {
  const hasDate = Boolean(sale.sale_date?.trim());
  const { status, reason } = keyFactStatus(fact, hasDate);
  if (hasDate || status === "to_confirm") {
    return item(
      "hearing",
      status,
      reason ?? (judicial ? "Date d’audience publiée." : "Date de vente publiée."),
      sourceOrigin(sale),
    );
  }
  const deadline = text(asRecordOrNull(procedure?.deadline)?.at) ?? text(procedure?.offer_deadline);
  if (deadline) {
    return item(
      "hearing",
      "present",
      "Échéance publiée par la source.",
      "Fiche source (procédure)",
    );
  }
  return item(
    "hearing",
    "missing",
    procedure?.pending === true
      ? "Le calendrier de la vente n’est pas encore publié."
      : judicial
        ? "La date d’audience n’est pas renseignée."
        : "La date de vente ou la date limite n’est pas renseignée.",
  );
}

function venueItem(
  sale: AuctionSale,
  procedure: Record<string, unknown> | null,
  judicial: boolean,
): InformationAgentInventoryItem {
  const method = `${text(procedure?.method) ?? ""} ${text(procedure?.method_label) ?? ""}`;
  if (/en[\s_]ligne|online/i.test(method) || sale.sale_venue_type === "online") {
    return item("venue", "present", "Vente en ligne.", "Fiche source (procédure)");
  }
  if (sale.tribunal?.trim())
    return item("venue", "present", sale.tribunal.trim(), sourceOrigin(sale));
  const venueName = text(asRecordOrNull(sale.sale_procedure)?.venue_name);
  if (venueName) return item("venue", "present", venueName, sourceOrigin(sale));
  return item(
    "venue",
    "missing",
    judicial
      ? "Le tribunal de la vente n’est pas identifié."
      : "Le lieu de la vente n’est pas précisé.",
  );
}

function startingPriceItem(
  sale: AuctionSale,
  fact: FactReliability | undefined,
  procedure: Record<string, unknown> | null,
): InformationAgentInventoryItem {
  const hasPrice = typeof sale.starting_price_eur === "number" && sale.starting_price_eur > 0;
  const { status, reason } = keyFactStatus(fact, hasPrice);
  if (hasPrice || status === "to_confirm") {
    return item("starting_price", status, reason ?? "Mise à prix publiée.", sourceOrigin(sale));
  }
  const prices = asRecordOrNull(procedure?.prices);
  const fallback = ["starting_price_eur", "asking_price_eur", "minimum_price_eur"].some(
    (key) => Number(prices?.[key]) > 0,
  );
  return fallback
    ? item("starting_price", "present", "Prix publié par la source.", "Fiche source (procédure)")
    : item("starting_price", "missing", "La mise à prix n’est pas renseignée.");
}

function surfaceItem(
  sale: AuctionSale,
  fact: FactReliability | undefined,
  characteristics: Record<string, unknown> | null,
  signals: InformationAgentInventorySignals,
  propertyType: string,
): InformationAgentInventoryItem {
  if (propertyType === "parking") {
    return item("surface", "not_applicable", "Sans objet pour un emplacement de stationnement.");
  }
  const surface = getSaleSurface(sale);
  const recorded = surface.value != null && !surface.estimated;
  const { status, reason } = keyFactStatus(fact, recorded);
  if (status === "to_confirm") {
    return item("surface", status, reason ?? "Surface à confirmer.", sourceOrigin(sale));
  }
  if (recorded) return item("surface", "present", surface.label, sourceOrigin(sale));
  const published = asRecordOrNull(characteristics?.surfaces);
  if (Number(published?.built_surface_m2) > 0 || Number(published?.surface_unscoped_m2) > 0) {
    return item(
      "surface",
      "present",
      "Surface publiée par la source.",
      "Fiche source (caractéristiques)",
    );
  }
  if (propertyType === "land" && Number(sale.land_surface_m2) > 0) {
    return item("surface", "present", "Surface du terrain publiée.", sourceOrigin(sale));
  }
  const pdf = signals.pdfFacts?.surface;
  if (pdf) {
    return item(
      "surface",
      "to_confirm",
      "Une surface figure dans une pièce du dossier mais n’est pas retenue pour la fiche.",
      pdfOrigin(pdf),
    );
  }
  if (surface.estimated) {
    return item("surface", "to_confirm", "Surface seulement estimée.", null);
  }
  return item("surface", "missing", "Aucune surface n’est publiée.");
}

function occupancyItem(
  sale: AuctionSale,
  fact: FactReliability | undefined,
  features: Record<string, unknown> | null,
  blocks: Record<string, unknown>,
  signals: InformationAgentInventorySignals,
): InformationAgentInventoryItem {
  const known = Boolean(
    sale.occupancy_status && !/^(?:unknown|inconnu)$/i.test(sale.occupancy_status),
  );
  const { status, reason } = keyFactStatus(fact, known);
  if (known || status === "to_confirm") {
    return item("occupancy", status, reason ?? "Occupation publiée.", sourceOrigin(sale));
  }
  if (
    featurePresent(features, "occupancy_physical") ||
    featurePresent(features, "legal_possession")
  ) {
    return item(
      "occupancy",
      "present",
      "Occupation publiée par la source.",
      "Caractéristiques source",
    );
  }
  const blockValue = text(blocks.occupation);
  if (blockValue && !/^(?:unknown|inconnu)$/i.test(blockValue)) {
    return item("occupancy", "present", "Occupation publiée par la source.", sourceOrigin(sale));
  }
  const pdf = signals.pdfFacts?.occupancy;
  if (pdf) {
    return item(
      "occupancy",
      "present",
      "Occupation décrite dans une pièce du dossier (à vérifier en revue).",
      pdfOrigin(pdf),
    );
  }
  return item("occupancy", "missing", "L’occupation du bien n’est pas renseignée.");
}

function visitsItem(
  sale: AuctionSale,
  blocks: Record<string, unknown>,
  procedure: Record<string, unknown> | null,
  signals: InformationAgentInventorySignals,
): InformationAgentInventoryItem {
  const values = [
    ...(Array.isArray(sale.visit_dates) ? sale.visit_dates : [sale.visit_dates]),
    blocks.visites,
    ...(Array.isArray(procedure?.visits) ? procedure.visits : []),
  ];
  const dated = values.some((value) => typeof value === "string" && publishedDay(value) !== null);
  if (dated) return item("visits", "present", "Date de visite publiée.", sourceOrigin(sale));
  if (signals.visitContact) {
    return item(
      "visits",
      "to_confirm",
      "Un contact de visite est publié, sans date.",
      sourceOrigin(sale),
    );
  }
  return item("visits", "missing", "Aucune date de visite exploitable n’est publiée.");
}

function photosItem(
  sale: AuctionSale,
  characteristics: Record<string, unknown> | null,
): InformationAgentInventoryItem {
  const fromMedia = propertyImages(sale.media).length;
  const fromSource = Number(asRecordOrNull(characteristics?.media)?.photos);
  const count = Math.max(fromMedia, Number.isFinite(fromSource) ? fromSource : 0);
  const label = `${count} photo${count > 1 ? "s" : ""} exploitable${count > 1 ? "s" : ""}`;
  if (count >= PHOTO_TARGET) return item("photos", "present", `${label}.`, sourceOrigin(sale));
  return item(
    "photos",
    count > 0 ? "to_confirm" : "missing",
    count > 0 ? `${label} seulement.` : "Aucune photo exploitable.",
  );
}

type DocumentEvidence = { label: string; origin: string };

function documentItem(
  key: InformationAgentMissingDocument,
  documents: DocumentEvidence[],
  applicable: boolean,
): InformationAgentInventoryItem {
  const found = documents.find((document) => DOCUMENT_PATTERNS[key].test(document.label));
  if (found) return item(key, "present", "Pièce disponible.", found.origin);
  if (!applicable) {
    return item(key, "not_applicable", "Pas de procès-verbal descriptif pour ce type de vente.");
  }
  return item(
    key,
    "missing",
    documents.length
      ? "Absent des pièces consultables."
      : "Aucune pièce consultable n’est rattachée à l’annonce.",
  );
}

function diagnosticsItem(
  documents: DocumentEvidence[],
  characteristics: Record<string, unknown> | null,
  features: Record<string, unknown> | null,
  signals: InformationAgentInventorySignals,
  withoutBuilding: boolean,
): InformationAgentInventoryItem {
  const document = documentItem("diagnostics", documents, true);
  if (document.status === "present") return document;
  if (withoutBuilding) {
    return item("diagnostics", "not_applicable", "Sans objet pour un terrain ou un stationnement.");
  }
  const energy = asRecordOrNull(characteristics?.energy);
  const classKnown =
    Boolean(text(energy?.dpe_class) || signals.energyClasses?.dpe) ||
    featurePresent(features, "dpe_class") ||
    Boolean(signals.pdfFacts?.energy);
  return classKnown
    ? item(
        "diagnostics",
        "missing",
        "Classe énergétique connue, mais le dossier de diagnostics n’est pas consultable.",
      )
    : document;
}

function cadastreItem(
  documents: DocumentEvidence[],
  blocks: Record<string, unknown>,
  characteristics: Record<string, unknown> | null,
  signals: InformationAgentInventorySignals,
): InformationAgentInventoryItem {
  const document = documents.find((entry) => DOCUMENT_PATTERNS.cadastre.test(entry.label));
  if (document) return item("cadastre", "present", "Pièce cadastrale disponible.", document.origin);
  const designation = text(asRecordOrNull(characteristics?.location)?.designation);
  const itemReference = (Array.isArray(characteristics?.items) ? characteristics.items : []).some(
    (entry) =>
      /cadastr/i.test(text(asRecordOrNull(entry)?.key) ?? "") && text(asRecordOrNull(entry)?.value),
  );
  const blockReference = Object.entries(blocks).some(
    ([key, value]) => /cadastr/i.test(key) && Boolean(text(value)),
  );
  if (designation || itemReference || blockReference || signals.cadastre) {
    return item("cadastre", "present", "Référence cadastrale publiée.", "Fiche source");
  }
  return item("cadastre", "missing", "Aucune référence cadastrale n’est publiée.");
}

function compositionItem(
  sale: AuctionSale,
  features: Record<string, unknown> | null,
  signals: InformationAgentInventorySignals,
  withoutBuilding: boolean,
): InformationAgentInventoryItem {
  if (withoutBuilding) {
    return item("composition", "not_applicable", "Sans objet pour un terrain ou un stationnement.");
  }
  if (sale.rooms_count != null) {
    return item("composition", "present", `${sale.rooms_count} pièce(s).`, sourceOrigin(sale));
  }
  if (featurePresent(features, "rooms_count")) {
    return item("composition", "present", "Nombre de pièces publié.", "Caractéristiques source");
  }
  const sourceText = [sale.title, sale.source_description, sale.description]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (/\b(?:T|F)\d\b|\b\d+\s*(?:pi[eè]ces?|chambres?)\b/i.test(sourceText)) {
    return item(
      "composition",
      "present",
      "Composition décrite dans l’annonce.",
      sourceOrigin(sale),
    );
  }
  const pdf = signals.pdfFacts?.rooms;
  if (pdf) {
    return item(
      "composition",
      "present",
      "Composition décrite dans une pièce du dossier (à vérifier en revue).",
      pdfOrigin(pdf),
    );
  }
  return item("composition", "missing", "Le nombre de pièces n’est pas confirmé.");
}

function saleTermsItem(
  sale: AuctionSale,
  documents: DocumentEvidence[],
): InformationAgentInventoryItem {
  if (hasVerifiedSaleTerms(sale)) {
    return item("sale_terms", "present", "Modalités vérifiées.", "Procédure vérifiée");
  }
  // Le cahier des conditions de vente fixe la garantie à remettre pour enchérir, les frais et les délais : s'il est
  // consultable, ces modalités se lisent dans la pièce plutôt que d'être redemandées.
  const conditions = documents.find((document) =>
    DOCUMENT_PATTERNS.sale_conditions.test(document.label),
  );
  if (conditions) {
    return item(
      "sale_terms",
      "present",
      "Modalités à lire dans le cahier des conditions de vente.",
      conditions.origin,
    );
  }
  return item("sale_terms", "missing", "Consignation, frais et délais ne sont pas étayés.");
}

export function hasVerifiedSaleTerms(sale: AuctionSale): boolean {
  const procedure = getSaleProcedure(sale).procedure;
  if (!procedure) return false;
  if (!["verified", "cross_checked"].includes(procedure.verification.status)) return false;
  if (!procedure.verification.case_sources.length) return false;
  const rules = procedure.rules;
  const hasBidMethod = Boolean(rules.bid_method.trim());
  const hasGuarantee =
    rules.guarantee.amount_eur != null ||
    rules.guarantee.rate_pct != null ||
    rules.guarantee.minimum_eur != null;
  const hasDeadline = rules.payment_deadline_days != null || rules.overbid.window_days != null;
  return hasBidMethod && hasGuarantee && hasDeadline;
}

/**
 * Libellés de toutes les pièces connues : `auction_documents` (toutes URL sources), colonne
 * `documents`, liste `source_blocks.documents` et pièces jointes de `caracteristiques_bien`.
 */
function documentLabels(
  sale: AuctionSale,
  blocks: Record<string, unknown>,
  characteristics: Record<string, unknown> | null,
): DocumentEvidence[] {
  const result: DocumentEvidence[] = [];
  for (const document of [...parseDocs(sale.documents_rich), ...parseDocs(sale.documents)]) {
    const typed = document as { name?: string; type?: string; document_type?: string | null };
    const label = [typed.name, typed.type, typed.document_type, document.url]
      .filter(Boolean)
      .join(" ");
    result.push({ label, origin: `Pièce : ${typed.name || typed.document_type || "document"}` });
  }
  const listed = text(blocks.documents);
  if (listed) {
    for (const name of listed
      .split(/[;\n]/)
      .map((value) => value.trim())
      .filter(Boolean)) {
      result.push({ label: name, origin: `Pièce citée par la source : ${name}` });
    }
  }
  for (const attachment of Array.isArray(characteristics?.attachments)
    ? characteristics.attachments
    : []) {
    const record = asRecordOrNull(attachment);
    const label = [text(record?.kind), text(record?.kind_label), text(record?.label)]
      .filter(Boolean)
      .join(" ");
    if (label) {
      result.push({
        label,
        origin: `Pièce jointe de la source : ${text(record?.kind_label) ?? text(record?.label) ?? "document"}`,
      });
    }
  }
  return result;
}

function featurePresent(features: Record<string, unknown> | null, key: string): boolean {
  const claim = asRecordOrNull(features?.[key]);
  if (!claim) return false;
  const state = text(claim.state);
  if (state && state !== "present" && state !== "observed") return false;
  const value = claim.value;
  return value !== null && value !== undefined && value !== "";
}

function pdfOrigin(pdf: {
  documentLabel: string | null;
  documentType: string | null;
  page: number | null;
}) {
  const name = pdf.documentLabel ?? pdf.documentType ?? "document";
  return `Pièce : ${name}${pdf.page ? `, page ${pdf.page}` : ""}`;
}

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Forme enregistrée de l'inventaire dans `metadata.inventory` de la mission. */
export function informationAgentInventorySnapshot(
  inventory: InformationAgentInventory,
): { key: string; label: string; status: string; detail: string; origin: string | null }[] {
  return inventory.items.map((entry) => ({
    key: entry.key,
    label: entry.label,
    status: entry.status,
    detail: entry.detail,
    origin: entry.origin,
  }));
}
