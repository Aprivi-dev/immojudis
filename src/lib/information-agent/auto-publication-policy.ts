import { detectPossiblePromptInjection } from "@/lib/information-agent-inbound/prompt-injection";

/**
 * Moteur de décision « publier ou relire » des informations extraites d'une réponse (étape 3 du plan
 * d'enrichissement, propositions 6 et 7). MODULE PUR : ni réseau, ni base, ni horloge (la date de
 * référence n'intervient pas : seules comptent les dates de l'envoi et de la réception).
 *
 * À cette étape, la décision n'est qu'une SIMULATION : elle est journalisée et affichée, jamais appliquée.
 * Aucun chemin ne publie (`app_private.apply_information_agent_fact` n'est appelé qu'avec 'admin').
 *
 * Règle appliquée (toutes les conditions sont requises, voir `docs/runbooks/information-agent.md`) :
 * réponse e-mail de l'adresse contactée, DKIM et DMARC « pass », moins de 30 jours après l'envoi, dossier
 * adressé à l'avocat poursuivant ; information du corps du message (jamais d'une pièce jointe) ; règles et IA
 * (version 3 ou suivante) d'accord sans motif, aucune autre valeur pour ce champ dans la réponse ; aucun
 * motif de relecture (phrase, lot, réponse) ; champ de la liste fermée, vide sur la fiche, valeur plausible
 * pour le type de bien ; ni « ne pas publier », ni nom de particulier, ni soupçon de manipulation ; plafonds
 * par jour et par dossier. Toute donnée manquante ou illisible donne « relecture » (échec fermé).
 */

/** Version de la règle, inscrite au journal avec chaque décision. */
export const AUTO_PUBLICATION_POLICY_VERSION = "auto_publication_v1";

/**
 * Liste fermée des champs éligibles. SEUL endroit qui la définit : la contrainte du journal
 * (`information_agent_auto_publication_decisions_eligible_check`, migration 20261115100000) est comparée à
 * cette liste par un test de concordance. Tout autre champ : toujours relecture.
 */
export const AUTO_PUBLICATION_ELIGIBLE_FIELDS = [
  "surface_m2",
  "land_surface_m2",
  "rooms_count",
] as const;
export type AutoPublicationEligibleField = (typeof AUTO_PUBLICATION_ELIGIBLE_FIELDS)[number];

/** Modes du réglage. « auto » est verrouillé à cette étape (contrainte en base et refus du serveur). */
export const AUTO_PUBLICATION_MODES = ["off", "simulation", "auto"] as const;
export type AutoPublicationMode = (typeof AUTO_PUBLICATION_MODES)[number];

/**
 * Plafonds appliqués dès la simulation. Par jour (heure de Paris) : au plus 10 informations publiées (ou
 * qui l'auraient été). Par dossier : au plus 2, sur les trois champs éligibles ; une réponse qui remplirait
 * d'un coup surface, terrain et pièces garde la troisième en relecture.
 */
export const AUTO_PUBLICATION_DAILY_CAP = 10;
export const AUTO_PUBLICATION_CASE_CAP = 2;

/** Délai maximal entre l'envoi de la demande et la réception de la réponse. */
export const AUTO_PUBLICATION_REPLY_WINDOW_DAYS = 30;
const REPLY_WINDOW_MS = AUTO_PUBLICATION_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Version minimale de la lecture par l'IA (`semantic_evidence_vN`). */
const MIN_SEMANTIC_VERSION = 3;

/** Motifs de refus du moteur : codes du journal et libellés affichés dans l'onglet Réponses. */
export const AUTO_PUBLICATION_REASON_LABELS = {
  input_unreadable: "données manquantes ou illisibles : relecture par précaution",
  field_not_eligible: "champ hors de la liste fermée (surface, terrain, nombre de pièces)",
  candidate_not_pending: "information en conflit avec la fiche ou déjà traitée",
  not_email_reply: "information arrivée par le portail ou consignée à la main, pas par e-mail",
  sender_not_contacted_address: "l’expéditeur n’est pas l’adresse contactée",
  sender_not_authenticated: "authentification DKIM et DMARC incomplète",
  reply_outside_window: "réponse reçue hors du délai de 30 jours après l’envoi",
  recipient_not_lawyer: "dossier adressé à un autre destinataire que l’avocat poursuivant",
  attachment_source: "information tirée d’une pièce jointe, pas du corps du message",
  semantic_not_confirmed:
    "l’IA n’a pas confirmé la valeur (lecture absente, ancienne ou en désaccord)",
  other_value_in_reply: "la réponse contient une autre valeur pour ce champ",
  statement_review_reason: "motif de relecture sur la phrase ou le lot",
  reply_in_review: "la réponse entière est en relecture ou n’est pas entièrement traitée",
  possible_manipulation: "soupçon de manipulation (consignes adressées à un modèle)",
  do_not_publish_requested: "la réponse demande de ne pas publier",
  private_person_named: "la réponse nomme un particulier",
  field_not_empty: "le champ est déjà renseigné sur la fiche",
  field_already_filled_in_simulation: "une autre information a déjà rempli ce champ en simulation",
  implausible_value: "valeur invraisemblable pour ce type de bien, ou type de bien inconnu",
  daily_cap_reached: `plafond atteint : ${AUTO_PUBLICATION_DAILY_CAP} informations par jour`,
  case_cap_reached: `plafond atteint : ${AUTO_PUBLICATION_CASE_CAP} informations par dossier`,
} as const satisfies Record<string, string>;

export type AutoPublicationReason = keyof typeof AUTO_PUBLICATION_REASON_LABELS;

export type AutoPublicationDecision =
  | { outcome: "would_publish"; reasons: [] }
  | { outcome: "review"; reasons: AutoPublicationReason[] };

/** Données lues pour un fait candidat. `null` : la donnée n'a pas pu être lue (échec fermé). */
export type AutoPublicationInput = {
  candidate: {
    factKey: string;
    status: string;
    evidenceAssetId: string | null;
    reviewedBy: string | null;
    proposedValue: unknown;
    metadata: unknown;
  };
  message: {
    direction: string | null;
    receivedAt: string | null;
    subject: string | null;
    bodyText: string | null;
    metadata: unknown;
  } | null;
  informationCase: { sentAt: string | null; recipientKind: string | null } | null;
  sale: {
    propertyType: string | null;
    surfaceM2: number | null;
    appSurfaceM2: number | null;
    landSurfaceM2: number | null;
    roomsCount: number | null;
  } | null;
  /** Nombre d'autres candidats du même message pour la même clé (toute provenance, tout statut). */
  otherCandidatesForKey: number | null;
  /** Un autre fait a déjà « rempli » ce champ de la vente dans la simulation. */
  fieldFilledInSimulation: boolean | null;
  /** Une lecture annexe a échoué (journal, vente…) : relecture, motif `input_unreadable`. */
  readFailed?: boolean;
};

/**
 * Bornes de plausibilité par type de bien (valeurs incluses). Un type absent de la table pour un champ :
 * valeur jamais plausible (par exemple le nombre de pièces d'un parking ou la surface habitable d'un terrain).
 */
const PLAUSIBLE_RANGES: Record<AutoPublicationEligibleField, Record<string, [number, number]>> = {
  surface_m2: {
    apartment: [9, 400],
    house: [15, 1000],
    building: [30, 10000],
    commercial: [5, 20000],
    mixed: [15, 10000],
    parking: [8, 100],
    other: [5, 5000],
  },
  land_surface_m2: {
    house: [20, 200000],
    land: [10, 5000000],
    building: [20, 200000],
    commercial: [20, 1000000],
    mixed: [20, 1000000],
    other: [10, 1000000],
  },
  rooms_count: {
    apartment: [1, 15],
    house: [1, 30],
  },
};

/** « Ne pas publier » et variantes (diffuser, divulguer, confidentiel). */
const DO_NOT_PUBLISH_RE =
  /\b(?:ne\s+(?:(?:pas|jamais|plus)\s+)?(?:(?:le|la|les|l['’]|cette|ces|cet|cela|ça|rien)\s*)?(?:publier|diffuser|divulguer|communiquer|mettre\s+en\s+ligne)|ne\s+(?:le\s+|la\s+|les\s+)?(?:publiez|diffusez|divulguez|communiquez|mettez)\s+(?:pas|rien|jamais)|pas\s+(?:de|pour)\s+(?:publication|diffusion)|non\s+(?:publiable|diffusable|communicable)|(?:strictement\s+)?confidentiel(?:le)?s?|sous\s+le\s+sceau\s+du\s+secret|off\s+the\s+record)\b/iu;

/**
 * Nom d'un particulier : civilité suivie d'un nom propre (« M. Martin », « Madame Durand », « les époux
 * Leroy », « consorts X »). « Maître » et « Me » ne comptent pas (l'avocat signe), ni « Madame, Monsieur, »
 * ni « Monsieur le Président ». Un faux positif coûte une relecture, jamais une publication.
 */
const PRIVATE_PERSON_RE =
  /(?:^|[^\p{L}])(?:M\.|MM\.|Mme|Mmes|Mlle|Mlles|Monsieur|Madame|Mademoiselle|[EeÉé]poux|[Cc]onsorts|[Vv]euve|[Ss]uccession|[Ii]ndivision|[Hh][ée]ritiers)\s+(?:de\s+|du\s+|d['’])?\p{Lu}[\p{L}'’-]+/u;

/** Version de la lecture par l'IA (`semantic_evidence_v3` → 3), ou null si illisible. */
function semanticVersion(method: unknown): number | null {
  if (typeof method !== "string") return null;
  const match = /^semantic_evidence_v(\d{1,4})$/.exec(method);
  return match ? Number(match[1]) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function timestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Valeur numérique proposée (`{ value: 65 }` ou `{ value: "65" }`), ou null si illisible. */
export function proposedNumber(proposedValue: unknown): number | null {
  const value = record(proposedValue)?.value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\d{1,9}(?:[.,]\d{1,4})?$/.test(value.trim())) {
    return Number(value.trim().replace(",", "."));
  }
  return null;
}

export function isAutoPublicationEligibleField(key: string): key is AutoPublicationEligibleField {
  return (AUTO_PUBLICATION_ELIGIBLE_FIELDS as readonly string[]).includes(key);
}

export function mentionsDoNotPublish(text: string): boolean {
  return DO_NOT_PUBLISH_RE.test(text.normalize("NFKC"));
}

export function namesPrivatePerson(text: string): boolean {
  return PRIVATE_PERSON_RE.test(text.normalize("NFKC"));
}

/** Valeur plausible pour le type de bien (bornes incluses, nombre de pièces entier). */
export function isPlausibleValue(
  field: AutoPublicationEligibleField,
  propertyType: string | null,
  value: number,
): boolean {
  if (!propertyType) return false;
  const range = PLAUSIBLE_RANGES[field][propertyType];
  if (!range) return false;
  if (field === "rooms_count" && !Number.isInteger(value)) return false;
  return value >= range[0] && value <= range[1];
}

function fieldIsEmpty(field: AutoPublicationEligibleField, sale: AutoPublicationInput["sale"]) {
  if (!sale) return false;
  if (field === "surface_m2") return sale.surfaceM2 == null && sale.appSurfaceM2 == null;
  if (field === "land_surface_m2") return sale.landSurfaceM2 == null;
  return sale.roomsCount == null;
}

/**
 * Décision pour un fait, sans les plafonds (voir `planAutoPublicationDecisions`). Rend tous les motifs de
 * refus trouvés, dans l'ordre des conditions.
 */
export function decideAutoPublication(input: AutoPublicationInput): AutoPublicationDecision {
  const reasons = new Set<AutoPublicationReason>();
  const { candidate, message, informationCase, sale } = input;
  if (input.readFailed) reasons.add("input_unreadable");

  // Champ de la liste fermée et candidat ouvert.
  const field = isAutoPublicationEligibleField(candidate.factKey) ? candidate.factKey : null;
  if (!field) reasons.add("field_not_eligible");
  if (candidate.status !== "pending" || candidate.reviewedBy !== null) {
    reasons.add("candidate_not_pending");
  }

  // 1. Réponse e-mail de l'adresse contactée, authentifiée, dans le délai, au dossier de l'avocat.
  const messageMetadata = record(message?.metadata);
  if (!message || !messageMetadata) {
    reasons.add("input_unreadable");
  } else {
    const channel = messageMetadata.channel;
    if (
      message.direction !== "inbound" ||
      messageMetadata.imported_manually !== false ||
      (channel !== undefined && channel !== "email")
    ) {
      reasons.add("not_email_reply");
    }
    if (messageMetadata.sender_matches_recipient !== true) {
      reasons.add("sender_not_contacted_address");
    }
    const authentication = record(messageMetadata.sender_authentication);
    if (authentication?.dkim !== "pass" || authentication?.dmarc !== "pass") {
      reasons.add("sender_not_authenticated");
    }
    const processing = record(messageMetadata.inbound_processing);
    if (!processing || processing.status !== "completed" || processing.reason != null) {
      reasons.add("reply_in_review");
    }
    const text = [message.subject, message.bodyText];
    if (typeof message.bodyText !== "string") {
      reasons.add("input_unreadable");
    } else {
      if (text.some((part) => typeof part === "string" && detectPossiblePromptInjection(part))) {
        reasons.add("possible_manipulation");
      }
      if (mentionsDoNotPublish(message.bodyText)) reasons.add("do_not_publish_requested");
      if (namesPrivatePerson(message.bodyText)) reasons.add("private_person_named");
    }
  }
  const receivedAt = timestamp(message?.receivedAt);
  const sentAt = timestamp(informationCase?.sentAt);
  if (!informationCase || receivedAt === null || sentAt === null) {
    reasons.add("input_unreadable");
  } else if (receivedAt < sentAt || receivedAt - sentAt >= REPLY_WINDOW_MS) {
    reasons.add("reply_outside_window");
  }
  if (informationCase && informationCase.recipientKind !== "source_lawyer") {
    reasons.add("recipient_not_lawyer");
  }

  // 2. Corps du message, jamais une pièce jointe.
  if (candidate.evidenceAssetId !== null) reasons.add("attachment_source");

  // 3. Règles et IA d'accord, aucune autre valeur pour ce champ.
  const metadata = record(candidate.metadata);
  if (!metadata) {
    reasons.add("input_unreadable");
  } else {
    const version = semanticVersion(metadata.semantic_extraction_method);
    if (
      metadata.semantic_agreement !== true ||
      version === null ||
      version < MIN_SEMANTIC_VERSION
    ) {
      reasons.add("semantic_not_confirmed");
    }
    // 4 et 5. Aucun motif sur la phrase ni sur le lot (un champ illisible compte comme un motif).
    const reviewReasons = metadata.review_reasons;
    if (
      (reviewReasons !== undefined &&
        (!Array.isArray(reviewReasons) || reviewReasons.length > 0)) ||
      metadata.lot_unidentified !== undefined
    ) {
      reasons.add("statement_review_reason");
    }
  }
  if (input.otherCandidatesForKey === null) reasons.add("input_unreadable");
  else if (input.otherCandidatesForKey > 0) reasons.add("other_value_in_reply");

  // 6. Champ vide sur la fiche, valeur plausible pour le type de bien.
  const value = proposedNumber(candidate.proposedValue);
  if (!sale) {
    reasons.add("input_unreadable");
  } else if (field) {
    if (!fieldIsEmpty(field, sale)) reasons.add("field_not_empty");
    if (value === null || !isPlausibleValue(field, sale.propertyType, value)) {
      reasons.add("implausible_value");
    }
  }
  if (input.fieldFilledInSimulation === null) reasons.add("input_unreadable");
  else if (input.fieldFilledInSimulation) reasons.add("field_already_filled_in_simulation");

  if (reasons.size === 0) return { outcome: "would_publish", reasons: [] };
  return { outcome: "review", reasons: [...reasons] };
}

export type AutoPublicationPlanItem = {
  factId: string;
  caseId: string;
  saleId: string;
  factKey: string;
  input: AutoPublicationInput;
};

export type AutoPublicationCounters = {
  /** Faits distincts publiés (ou qui l'auraient été) aujourd'hui, heure de Paris, hors faits du lot. */
  today: number;
  /** Même décompte par dossier, toutes dates. */
  byCase: ReadonlyMap<string, number>;
  /** Champs déjà remplis dans la simulation, clé `vente:champ`. */
  filled: ReadonlySet<string>;
};

/**
 * Décisions d'un lot de faits, dans l'ordre donné (le plus ancien d'abord), avec les plafonds : un fait qui
 * passerait toutes les conditions devient « relecture » si le plafond du jour ou du dossier est atteint.
 * Les compteurs et les champs remplis avancent au fil du lot.
 */
export function planAutoPublicationDecisions(
  items: AutoPublicationPlanItem[],
  counters: AutoPublicationCounters | null,
): Array<{ item: AutoPublicationPlanItem; decision: AutoPublicationDecision }> {
  let today = counters?.today ?? 0;
  const byCase = new Map(counters?.byCase ?? []);
  const filled = new Set(counters?.filled ?? []);
  return items.map((item) => {
    const fieldKey = `${item.saleId}:${item.factKey}`;
    const base = decideAutoPublication({
      ...item.input,
      readFailed: item.input.readFailed || counters === null,
      fieldFilledInSimulation:
        item.input.fieldFilledInSimulation === null ? null : filled.has(fieldKey),
    });
    if (base.outcome !== "would_publish") return { item, decision: base };
    const reasons: AutoPublicationReason[] = [];
    if (today >= AUTO_PUBLICATION_DAILY_CAP) reasons.push("daily_cap_reached");
    if ((byCase.get(item.caseId) ?? 0) >= AUTO_PUBLICATION_CASE_CAP) {
      reasons.push("case_cap_reached");
    }
    if (reasons.length) return { item, decision: { outcome: "review", reasons } };
    today += 1;
    byCase.set(item.caseId, (byCase.get(item.caseId) ?? 0) + 1);
    filled.add(fieldKey);
    return { item, decision: base };
  });
}

/** Libellés lisibles des motifs ; un code inconnu reste signalé. */
export function autoPublicationReasonLabels(reasons: readonly string[]): string[] {
  return [
    ...new Set(
      reasons.map((reason) =>
        Object.hasOwn(AUTO_PUBLICATION_REASON_LABELS, reason)
          ? AUTO_PUBLICATION_REASON_LABELS[reason as AutoPublicationReason]
          : "motif non reconnu",
      ),
    ),
  ];
}
