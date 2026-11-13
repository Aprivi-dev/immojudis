import { occupancyLabel } from "@/lib/format";
import { listingOccupation } from "@/lib/listing-evidence";
import { occupancyClass, type OccupancyClass } from "@/lib/occupancy-status";
import type { AuctionSale } from "@/lib/types";
import { dedupeEvidence, excerpt, normalizeText } from "@/lib/analysis-text";
import { cleanText, type TextCandidate } from "@/lib/clean-text";
import { collectSaleTextCandidates } from "@/lib/sale-text-candidates";

type OccupancyStatusKind = "free" | "occupied" | "rented" | "to_confirm" | "conflicting";

type OccupancyEvidence = {
  status: Exclude<OccupancyStatusKind, "conflicting">;
  label: string;
  excerpt: string;
  source: string;
};

export type OccupancyAnalysis = {
  available: boolean;
  status: OccupancyStatusKind;
  label: string;
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  hasLeaseSignal: boolean;
  hasEvictionSignal: boolean;
  evidence: OccupancyEvidence[];
  sources: string[];
  summary: string;
  decisionImpact: string;
  nextActions: string[];
  limitations: string[];
};

const OCCUPANCY_KEY =
  /occup|occupation|occupancy|bail|locataire|locative|tenant|rented|lease|vacant|libre/i;

/** Ce que vend la vente : « libre », « vide » ou « vacant » qui le suivent disent son occupation. */
const PREMISES =
  "(?:bien|lot|logement|appartement|maison|studio|pavillon|villa|local|locaux|immeuble)s?";
/**
 * « libre de » ne dit l'occupation que suivi d'elle (premier motif) : « libre de toute
 * inscription » ou « libre d'hypothèque » parlent des charges du bien.
 */
const NOT_FREE_OF = String.raw`(?!\s+(?:de|du|d)\s)`;
/** « aucun logement libre », « aucun bail en cours », « pas de loyer perçu » disent le contraire. */
const NOT_DENIED = String.raw`(?<!\b(?:aucun|pas\s+de|sans)\s+)`;
/**
 * « part des logements vacants », « taxe sur les logements vacants » : une statistique de la
 * commune (lue par `demographic-analysis.ts`), pas l'occupation du bien.
 */
const NOT_STATISTIC = String.raw`(?<!\b(?:part|taux|nombre|taxe\s+sur)\s+(?:de\s+|des\s+|les\s+)?)`;

// « libre », « vide » et « vacant » seuls disent aussi un accès, un parking visiteurs, un vide
// sanitaire ou un terrain vacant : ils ne comptent que dans une phrase d'occupation. Un texte qui
// n'en a pas reste « À confirmer ».
const FREE_PATTERNS = [
  /\b(?:libre|vide)s?\s+(?:de\s+tout(?:e|s|es)?\s+|d\s+)(?:occupation|occupant|location|bail)/i,
  new RegExp(
    String.raw`${NOT_DENIED}${NOT_STATISTIC}\b${PREMISES}\s+` +
      String.raw`(?:(?:est|sont|sera|seront|actuellement|desormais)\s+){0,2}` +
      String.raw`(?:libre|vide|vacante?)s?\b${NOT_FREE_OF}`,
    "i",
  ),
  new RegExp(
    String.raw`\b(?:il|elle)s?\s+(?:est|sont|sera|seront)\s+(?:(?:actuellement|desormais)\s+)?` +
      String.raw`libres?\b${NOT_FREE_OF}`,
    "i",
  ),
  new RegExp(String.raw`\bvendue?s?\s+libres?\b${NOT_FREE_OF}`, "i"),
  // Champ de la source nommé d'après l'occupation (« occupation: Libre », « situationLocative:
  // LIBRE », « occupancy_status: vacant »). « free » ne compte que là : dans un texte, il dit aussi
  // l'opérateur Free (« fibre Orange, Free, SFR »).
  /(?:occup|locative)[\w.[\]]*\s*:\s*(?:libres?|free|vacant)\b/i,
  /\bnon\s+occup(?:e|ee|é|ée)\b/i,
  /\binoccup(?:e|ee|é|ée)\b/i,
];

/** Sortes de bail qui peuvent suivre « bail » (« bail commercial », « bail d'habitation »). */
const LEASE_KIND = String.raw`(?:\s+(?:commercial|professionnel|d\s+habitation|mixte|rural|meuble))?`;
/** Désignation d'un bail : « Bail », « Bail commercial », « Contrat de bail d'habitation ». */
const LEASE_DESIGNATION = String.raw`(?:contrat\s+de\s+)?bail${LEASE_KIND}`;

// « bail » et « loyer » dans une phrase disent aussi un bail passé ou absent (« bail à construction
// expiré », « aucun bail annexé ») ou un loyer estimé (« loyer de marché estimé », « loyer
// potentiel ») : ils ne comptent que dans une phrase de location en cours, ou seuls comme désignation
// d'un bail (texte, valeur d'un champ, pièce du dossier). Un texte qui n'en a pas reste « À confirmer ».
const RENTED_PATTERNS = [
  /\blou(?:e|ee|é|ée)\b/i,
  /\blocataire\b/i,
  // Un texte qui n'est que la désignation d'un bail (« Bail commercial. »).
  new RegExp(String.raw`^${LEASE_DESIGNATION}\s*\.?$`, "i"),
  // Champ de la source nommé d'après l'occupation ou le bail, dont la valeur est un bail
  // (« bail: Bail commercial ») ou un locataire (« occupancy: tenant »). « tenant » ne compte que
  // là : dans un texte français, il dit « en tenant compte de ».
  new RegExp(
    String.raw`(?:occup|locative|bail)[\w.[\]]*\s*:\s*(?:${LEASE_DESIGNATION}|tenant)\b`,
    "i",
  ),
  new RegExp(String.raw`${NOT_DENIED}\bbail${LEASE_KIND}\s+en\s+cours\b`, "i"),
  /\b(?:suivant|selon|en\s+vertu\s+d\s+un|titulaire\s+d\s+un|donnee?s?\s+a)\s+bail\b/i,
  // Loyer chiffré : « loyer mensuel de 650 € », « loyer actuel : 520 € », « loyer 500 euros ».
  /\bloyers?\s+(?:(?:mensuel|annuel|trimestriel|actuel)s?\s+)?(?:de\s+|:\s*)?\d/i,
  new RegExp(
    String.raw`${NOT_DENIED}\bloyers?\s+(?:percus?|encaisses?|payes?|regles?|verses?|en\s+cours)\b`,
    "i",
  ),
  /\bmoyennant\s+(?:un\s+)?loyer\b/i,
  /\brented\b/i,
  /\blease\b/i,
];

/** Pièce du dossier qui est un bail : son type (`bail`) ou son libellé (« Bail commercial du… »). */
const LEASE_DOCUMENT = new RegExp(String.raw`^${LEASE_DESIGNATION}\b`, "i");

const OCCUPIED_PATTERNS = [
  /\boccup(?:e|ee|ant|ante|ants|é|ée)\b/i,
  /\bpresence\s+(?:d\s+|de\s+|des\s+)(?:un\s+|une\s+)?(?:occupants?|locataires?|habitants?|personnes?)\b/i,
  /\bhabite\b/i,
  /\bse\s+declarant\s+occupant\b/i,
];

const TO_CONFIRM_PATTERNS = [
  /\ba\s+confirmer\b/i,
  /\bnon\s+(?:renseigne|precise|stabilise|communique)\b/i,
  /\binconnu\b/i,
  /\babsence\s+de\s+bail\b/i,
  /\bbail\s+non\s+(?:produit|communique)\b/i,
];

const EVICTION_PATTERNS = [
  /\bexpulsion\b/i,
  /\bliberation\b/i,
  /\bdelai\s+de\s+sortie\b/i,
  /\bcommandement\s+de\s+quitter\b/i,
  /\bmaintien\s+dans\s+les\s+lieux\b/i,
];

export function buildOccupancyAnalysis(sale: AuctionSale): OccupancyAnalysis {
  const candidates = collectTextCandidates(sale);
  const fieldEvidence = evidenceFromOccupancyStatus(sale.occupancy_status);
  const textEvidence = [
    ...collectTextEvidence(candidates),
    ...leaseDocumentEvidence(sale.documents_rich),
  ];
  const allEvidence = dedupeEvidence([...fieldEvidence, ...textEvidence]);
  // Keep each distinct status visible, including contradictions found after the display cap.
  const seenStatuses = new Set<OccupancyEvidence["status"]>();
  const firstByStatus = allEvidence.filter((item) => {
    if (seenStatuses.has(item.status)) return false;
    seenStatuses.add(item.status);
    return true;
  });
  const evidence = [
    ...firstByStatus,
    ...allEvidence.filter((item) => !firstByStatus.includes(item)),
  ].slice(0, 8);
  const atConstat = listingOccupation(sale) === "Inoccupé au constat";
  const resolvedStatus = resolveStatus(allEvidence);
  const status = atConstat && resolvedStatus === "free" ? "to_confirm" : resolvedStatus;
  const sources = [...new Set(evidence.map((item) => item.source))].slice(0, 8);
  const hasLeaseSignal =
    evidence.some((item) => item.status === "rented") || hasPattern(candidates, RENTED_PATTERNS);
  const hasEvictionSignal = hasPattern(candidates, EVICTION_PATTERNS);
  const confidence = resolveConfidence({ status, evidence, fieldEvidence });

  return {
    available: status !== "to_confirm" || evidence.length > 0,
    status,
    label: atConstat && status === "to_confirm" ? "Inoccupé au constat" : statusLabel(status),
    confidence,
    confidenceLabel: confidenceLabel({ status, confidence }),
    hasLeaseSignal,
    hasEvictionSignal,
    evidence,
    sources,
    summary:
      atConstat && status === "to_confirm"
        ? "Inoccupé au constat. La disponibilité actuelle reste à confirmer."
        : summary({ status, evidence, hasLeaseSignal, hasEvictionSignal }),
    decisionImpact: decisionImpact({ status, hasLeaseSignal, hasEvictionSignal }),
    nextActions: nextActions({ status, hasLeaseSignal, hasEvictionSignal }),
    limitations: limitations(status, sources),
  };
}

const FIELD_STATUS_BY_CLASS: Record<OccupancyClass, OccupancyEvidence["status"]> = {
  vacant: "free",
  occupied: "occupied",
  rented: "rented",
};

function evidenceFromOccupancyStatus(status: AuctionSale["occupancy_status"]): OccupancyEvidence[] {
  const normalized = normalizeText(status ?? "");
  if (!normalized || normalized === "unknown" || normalized === "inconnu") {
    return [
      {
        status: "to_confirm",
        label: "Statut non renseigné",
        excerpt: occupancyLabel(status),
        source: "Champ occupation",
      },
    ];
  }
  // Le champ est un code de la base (owner_occupied, squatted…) : il se lit par sa classe, comme
  // l'écart au marché et le plafond ; les motifs de `detectStatus` sont faits pour les textes.
  const occupancy = occupancyClass(status);
  return [
    {
      status: occupancy ? FIELD_STATUS_BY_CLASS[occupancy] : "to_confirm",
      label: occupancyLabel(status),
      excerpt: occupancyLabel(status),
      source: "Champ occupation",
    },
  ];
}

function collectTextEvidence(candidates: TextCandidate[]): OccupancyEvidence[] {
  const evidence: OccupancyEvidence[] = [];
  for (const candidate of candidates) {
    const detected = detectStatus(candidate.text);
    if (!detected) continue;
    evidence.push({
      status: detected,
      label: statusLabel(detected),
      excerpt: excerpt(candidate.text),
      source: candidate.source,
    });
  }
  return evidence;
}

/**
 * Une pièce dont le type ou le libellé désigne un bail est un indice de location, lu sur la pièce et
 * non dans son texte : « bail bail Bail », texte de la pièce, n'est pas une phrase.
 */
function leaseDocumentEvidence(documents: AuctionSale["documents_rich"]): OccupancyEvidence[] {
  return (documents ?? [])
    .filter((document) =>
      [document.type, document.document_type, document.label].some((value) =>
        LEASE_DOCUMENT.test(normalizeText(value ?? "")),
      ),
    )
    .map((document) => ({
      status: "rented",
      label: statusLabel("rented"),
      excerpt: excerpt(cleanText(document.label) ?? "Bail"),
      source: "Pièces du dossier",
    }));
}

function detectStatus(value: string): OccupancyEvidence["status"] | null {
  const text = normalizeText(value);
  const matches = (patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));
  if (matches(FREE_PATTERNS)) return "free";
  // Un doute (« bail non produit », « à confirmer ») retient « Loué », mais pas un occupant déclaré :
  // « se déclarant occupante ; bail non produit » reste un indice « occupé ».
  const doubt = matches(TO_CONFIRM_PATTERNS);
  if (!doubt && matches(RENTED_PATTERNS)) return "rented";
  if (matches(OCCUPIED_PATTERNS)) return "occupied";
  return doubt ? "to_confirm" : null;
}

function resolveStatus(evidence: OccupancyEvidence[]): OccupancyStatusKind {
  const statuses = new Set(
    evidence.map((item) => item.status).filter((status) => status !== "to_confirm"),
  );
  if (statuses.has("free") && (statuses.has("rented") || statuses.has("occupied")))
    return "conflicting";
  if (statuses.has("rented")) return "rented";
  if (statuses.has("occupied")) return "occupied";
  if (statuses.has("free")) return "free";
  return "to_confirm";
}

function resolveConfidence({
  status,
  evidence,
  fieldEvidence,
}: {
  status: OccupancyStatusKind;
  evidence: OccupancyEvidence[];
  fieldEvidence: OccupancyEvidence[];
}): OccupancyAnalysis["confidence"] {
  if (status === "conflicting" || status === "to_confirm") return "low";
  const fieldStatus = fieldEvidence[0]?.status;
  const corroboratingSources = new Set(
    evidence.filter((item) => item.status === status).map((item) => item.source),
  );
  // Field labels do not establish independent provenance: several fields may come from one publication.
  if (fieldStatus === status || corroboratingSources.size >= 2) return "medium";
  return "low";
}

function confidenceLabel({
  status,
  confidence,
}: {
  status: OccupancyStatusKind;
  confidence: OccupancyAnalysis["confidence"];
}): string {
  if (status === "conflicting") return "Signaux contradictoires à arbitrer";
  if (status === "to_confirm") return "Occupation à confirmer dans les pièces";
  if (confidence === "high") return "Indices concordants, occupation à confirmer";
  if (confidence === "medium") return "Statut repéré, à confirmer";
  return "Indice faible";
}

function summary({
  status,
  evidence,
  hasLeaseSignal,
  hasEvictionSignal,
}: {
  status: OccupancyStatusKind;
  evidence: OccupancyEvidence[];
  hasLeaseSignal: boolean;
  hasEvictionSignal: boolean;
}): string {
  const parts = [statusLabel(status)];
  if (hasLeaseSignal) parts.push("signal de bail ou loyer");
  if (hasEvictionSignal) parts.push("signal de délai de libération");
  if (evidence.length) parts.push(`${evidence.length} indice(s)`);
  return `${parts.join(" · ")}.`;
}

function decisionImpact({
  status,
  hasLeaseSignal,
  hasEvictionSignal,
}: {
  status: OccupancyStatusKind;
  hasLeaseSignal: boolean;
  hasEvictionSignal: boolean;
}): string {
  if (status === "conflicting") {
    return "Ne pas figer l’enchère plafond avant d'avoir levé la contradiction entre les sources (annonce, PV descriptif, cahier des conditions).";
  }
  if (status === "free") {
    return "Hypothèse favorable pour la jouissance et les travaux, sous réserve de confirmation au PV.";
  }
  if (status === "rented" || hasLeaseSignal) {
    return "Le plafond dépend du bail, du loyer, des impayés éventuels et des conditions de sortie.";
  }
  if (status === "occupied" || hasEvictionSignal) {
    return "Anticiper délai de libération, accès au bien, trésorerie immobilisée et calendrier travaux.";
  }
  return "Statut bloquant pour le plafond : une occupation inconnue peut déplacer le risque et le calendrier.";
}

function nextActions({
  status,
  hasLeaseSignal,
  hasEvictionSignal,
}: {
  status: OccupancyStatusKind;
  hasLeaseSignal: boolean;
  hasEvictionSignal: boolean;
}): string[] {
  const actions = [
    "Relire le PV descriptif et le cahier des conditions pour confirmer qui occupe le bien.",
  ];
  if (status === "rented" || hasLeaseSignal) {
    actions.push("Relever bail, loyer, dépôt, impayés, durée restante et clauses de sortie.");
  }
  if (status === "occupied" || hasEvictionSignal || status === "conflicting") {
    actions.push("Chiffrer le délai de libération et son impact sur travaux, revente ou location.");
  }
  if (status === "free") {
    actions.push("Confirmer l'absence d'occupation le jour de la visite ou auprès du conseil.");
  }
  actions.push("Demander au conseil les conséquences pratiques avant de déposer la consignation.");
  return actions.slice(0, 4);
}

function limitations(status: OccupancyStatusKind, sources: string[]): string[] {
  const items = [
    "L'analyse repose sur les champs collectés et les extraits disponibles, pas sur une consultation juridique.",
    "Le statut réel doit être confirmé dans les pièces officielles et, si possible, lors de la visite.",
  ];
  if (status === "conflicting" || status === "to_confirm") {
    items.unshift("Le dossier ne permet pas encore de qualifier fermement l'occupation.");
  }
  if (sources.length === 1 && sources[0] === "Champ occupation") {
    items.push(
      "Le statut provient des données collectées sur la vente ; aucun extrait de pièce ne le confirme dans ce rapport.",
    );
  }
  if (status === "occupied") {
    items.push(
      "Le délai de libération dépend du statut de l'occupant et de la procédure d'expulsion applicable ; il est à faire estimer par un conseil.",
    );
  }
  return items;
}

function statusLabel(status: OccupancyStatusKind): string {
  const labels: Record<OccupancyStatusKind, string> = {
    free: "Libre",
    occupied: "Occupé",
    rented: "Loué",
    to_confirm: "À confirmer",
    conflicting: "Signaux contradictoires",
  };
  return labels[status];
}

function collectTextCandidates(sale: AuctionSale): TextCandidate[] {
  return collectSaleTextCandidates(sale, {
    descriptions: "each",
    sourceFields: ({ path, value }) => OCCUPANCY_KEY.test(path) || hasOccupancyText(value),
    documents: sale.documents_rich,
    risks: sale.risks,
  }).filter((candidate) => hasOccupancyText(candidate.text));
}

function hasPattern(candidates: TextCandidate[], patterns: RegExp[]): boolean {
  return candidates.some((candidate) =>
    patterns.some((pattern) => pattern.test(normalizeText(candidate.text))),
  );
}

function hasOccupancyText(value: unknown): boolean {
  const text = cleanText(value);
  return Boolean(text && detectStatus(text));
}
