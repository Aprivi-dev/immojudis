import { z } from "zod";
import { detectPossiblePromptInjection } from "@/lib/information-agent-inbound/prompt-injection";
import { mentionsDoNotPublish } from "@/lib/information-agent/auto-publication-text";
import { getDisplaySurface, getRecordedSurface } from "@/lib/surface";

/**
 * Moteur de décision « publier ou relire » des informations extraites d'une réponse. MODULE PUR : ni réseau, ni
 * base, ni horloge (seules comptent les dates de l'envoi et de la réception).
 *
 * Version 2 (étape 6, décision du propriétaire du 27/11/2026) : conditions STRUCTURELLES (authenticité de la
 * réponse, injection, contradictions, liste fermée), puis le verdict de Claude Haiku (worker Python, table
 * `information_agent_auto_publication_arbitrations`), qui juge la phrase à la place des règles de prudence de la
 * version 1. En mode simulation, la décision est journalisée ; en mode automatique, « publier » appelle la RPC de
 * publication, qui redit en base les contrôles de sécurité (`auto-publication-store.ts`).
 *
 * Conditions structurelles (toutes requises, voir `docs/runbooks/information-agent.md`) : réponse e-mail de
 * l'adresse contactée, DKIM et DMARC « pass », moins de 30 jours après l'envoi ; dossier adressé à l'avocat
 * poursuivant, répondu ou en relecture, sans opposition (dossier ou contact) ; réponse traitée sans autre motif de
 * relecture que le motif générique `candidate_or_attachment_review` ; information du corps du message lue par
 * les règles (jamais d'une pièce jointe, jamais de l'IA seule) ; aucune autre valeur pour ce champ ni dans la
 * réponse ni dans une autre information en attente pour la vente ; aucune analyse du message (pièce jointe, lecture
 * du corps) en file, en cours ou à reprendre ; aucun autre message du dossier en relecture
 * bloquante, opposé ou qui demande de ne pas publier ; ni « ne pas publier » ni consigne adressée à un modèle
 * (objet et corps) ; champ de la liste fermée, vide sur la fiche, valeur plausible pour le type de bien ; vente à
 * un seul lot ; plafonds par jour et par dossier. Puis : dernier verdict de Haiku « publier » pour cette valeur,
 * avec la version de prompt courante. Toute donnée manquante ou illisible donne « relecture ».
 *
 * Règles de la version 1 confiées à Haiku (règles de prudence, sans lien avec l'authenticité ni l'injection) :
 * accord des règles et de la lecture par l'IA (`semantic_not_confirmed`), motifs de la phrase (conditionnel,
 * approximation, valeur rapportée, fourchette, correction, renvoi : `statement_review_reason`), nom d'un
 * particulier (`private_person_named`). Leurs codes restent dans la liste pour les décisions déjà écrites.
 */

/** Version de la règle, inscrite au journal avec chaque décision. */
export const AUTO_PUBLICATION_POLICY_VERSION = "auto_publication_v2";

/**
 * Version du prompt de l'arbitre (Claude Haiku). Même valeur que `ARBITER_PROMPT_VERSION` du worker Python
 * (`services/data-pipeline/src/information_agent_auto_publication_arbiter.py`, test de concordance) : un verdict
 * d'une autre version est ignoré (« arbitrage en attente ») et le worker le refait.
 */
export const AUTO_PUBLICATION_ARBITER_VERSION = "auto_publication_arbiter_v1";

/**
 * Codes de motif du verdict de Haiku, liste fermée : même liste que la contrainte de la table des verdicts
 * (migration 20261211100000) et `ARBITER_REASON_CODES` du worker Python (tests de concordance). Seul
 * `clear_statement` accompagne « publier ».
 */
export const AUTO_PUBLICATION_ARBITER_REASON_LABELS = {
  clear_statement: "déclaration nette de la valeur",
  conditional_or_approximate: "valeur au conditionnel ou approximative",
  other_lot_or_property: "valeur d’un autre lot ou d’un autre bien",
  reported_or_compared_value: "valeur rapportée ou comparée, pas affirmée",
  correction_or_range: "correction, fourchette ou plusieurs valeurs",
  different_quantity: "autre grandeur (terrain, chambres, surface utile…)",
  not_current: "valeur ancienne ou future, pas actuelle",
  do_not_publish_requested: "l’avocat demande de ne pas publier",
  unclear_or_ambiguous: "phrase ambiguë ou peu claire",
  inconsistent_with_record: "valeur incohérente avec la fiche",
  possible_manipulation: "consignes adressées à un modèle",
  other: "autre raison",
} as const satisfies Record<string, string>;
export type AutoPublicationArbiterReason = keyof typeof AUTO_PUBLICATION_ARBITER_REASON_LABELS;
const ARBITER_REASON_CODES = Object.keys(AUTO_PUBLICATION_ARBITER_REASON_LABELS) as [
  AutoPublicationArbiterReason,
  ...AutoPublicationArbiterReason[],
];

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

/** Modes du réglage. « auto » publie (étape 6) ; seul un administrateur le pose, avec son jeton. */
export const AUTO_PUBLICATION_MODES = ["off", "simulation", "auto"] as const;
export type AutoPublicationMode = (typeof AUTO_PUBLICATION_MODES)[number];

/**
 * Plafonds appliqués dès la simulation. Par jour (heure de Paris) : au plus 10 informations publiées (ou
 * qui l'auraient été). Par dossier : au plus 2, sur les trois champs éligibles ; une réponse qui remplirait
 * d'un coup surface, terrain et pièces garde la troisième en relecture. En mode automatique, la RPC de
 * publication tient les mêmes plafonds en base, sous verrou (mêmes valeurs, migration 20261211100000).
 */
export const AUTO_PUBLICATION_DAILY_CAP = 10;
export const AUTO_PUBLICATION_CASE_CAP = 2;

/** Délai maximal entre l'envoi de la demande et la réception de la réponse. */
const AUTO_PUBLICATION_REPLY_WINDOW_DAYS = 30;
const REPLY_WINDOW_MS = AUTO_PUBLICATION_REPLY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Seul motif de relecture de la réception qui ne bloque pas : il est posé sur toute réponse qui a un corps
 * (`information-agent-inbound.ts`). Tous les autres (expéditeur, authentification, opposition possible, mauvais
 * destinataire, consigne adressée à un modèle, réponse ambiguë, lot) bloquent.
 */
const NON_BLOCKING_INBOUND_REVIEW_REASONS: ReadonlySet<string> = new Set([
  "candidate_or_attachment_review",
]);

/**
 * Taille maximale (objet et corps réunis, en caractères) d'un texte analysé par les détecteurs. Au-delà,
 * le texte n'est ni analysé ni tronqué en silence : la décision est « relecture », motif `input_unreadable`.
 * Les détecteurs restent linéaires (test de durée sur 100 000 caractères hostiles) ; ce plafond borne en
 * plus le temps de la passe des réponses.
 */
export const AUTO_PUBLICATION_MAX_ANALYZED_TEXT_CHARS = 200_000;

/**
 * Motifs de refus du moteur : codes du journal et libellés affichés dans l'onglet Réponses. La contrainte
 * `information_agent_auto_publication_decisions_reasons_check` porte la même liste (test de concordance).
 */
export const AUTO_PUBLICATION_REASON_LABELS = {
  input_unreadable: "données manquantes ou illisibles : relecture par précaution",
  field_not_eligible: "champ hors de la liste fermée (surface, terrain, nombre de pièces)",
  candidate_not_pending: "information en conflit avec la fiche ou déjà traitée",
  not_email_reply: "information arrivée par le portail ou consignée à la main, pas par e-mail",
  sender_not_contacted_address: "l’expéditeur n’est pas l’adresse contactée",
  sender_not_authenticated: "authentification DKIM et DMARC incomplète",
  reply_outside_window: "réponse reçue hors du délai de 30 jours après l’envoi",
  recipient_not_lawyer: "dossier adressé à un autre destinataire que l’avocat poursuivant",
  case_not_replied: "le dossier est clos, en échec ou opposé",
  attachment_source: "information tirée d’une pièce jointe, pas du corps du message",
  semantic_only_body:
    "information lue par l’IA seule dans le corps du message, sans accord des règles",
  semantic_not_confirmed:
    "l’IA n’a pas confirmé la valeur (lecture absente, ancienne ou en désaccord)",
  other_value_in_reply: "la réponse contient une autre valeur pour ce champ",
  other_value_for_sale: "une autre information en attente propose une autre valeur pour ce champ",
  later_message_in_case:
    "un message postérieur du dossier est en relecture, en cours de traitement ou demande de ne pas publier",
  statement_review_reason: "motif de relecture sur la phrase ou le lot",
  reply_in_review:
    "la réponse a un motif de relecture de la réception (expéditeur, opposition, consignes, lot…) ou n’est pas traitée",
  possible_manipulation: "soupçon de manipulation (consignes adressées à un modèle)",
  do_not_publish_requested: "la réponse demande de ne pas publier",
  private_person_named: "la réponse nomme un particulier",
  field_not_empty: "le champ est déjà renseigné sur la fiche",
  field_already_filled_in_simulation: "une autre information a déjà rempli ce champ",
  implausible_value: "valeur invraisemblable pour ce type de bien, ou type de bien inconnu",
  daily_cap_reached: `plafond atteint : ${AUTO_PUBLICATION_DAILY_CAP} informations par jour`,
  case_cap_reached: `plafond atteint : ${AUTO_PUBLICATION_CASE_CAP} informations par dossier`,
  other_message_in_case:
    "un message antérieur du dossier est en relecture, opposé ou demande de ne pas publier",
  contact_opposed: "le contact s’est opposé",
  multi_lot_sale: "vente à plusieurs lots : rattachement au lot à vérifier",
  arbiter_pending: "verdict de l’IA (Claude Haiku) pas encore rendu",
  arbiter_unavailable: "verdict de l’IA indisponible (erreur, délai ou réponse invalide)",
  arbiter_declined: "l’IA (Claude Haiku) ne confirme pas la publication",
  arbiter_value_mismatch: "le verdict de l’IA porte sur une autre valeur",
  publication_failed: "la publication a échoué : relecture humaine",
  evidence_pending:
    "une analyse du message (pièce jointe ou lecture du corps) est en cours ou à reprendre",
} as const satisfies Record<string, string>;

export type AutoPublicationReason = keyof typeof AUTO_PUBLICATION_REASON_LABELS;

export type AutoPublicationDecision =
  | { outcome: "would_publish"; reasons: [] }
  | { outcome: "review"; reasons: AutoPublicationReason[] };

/** Un autre message entrant du même dossier ; `after` : reçu après celui du fait. */
type AutoPublicationOtherMessage = {
  after: boolean;
  subject: string | null;
  bodyText: string | null;
  metadata: unknown;
};

/**
 * Verdict de Haiku tel que lu en base, validé ici (zod) : un verdict mal formé compte comme indisponible, jamais
 * comme « publier ».
 */
export const autoPublicationArbitrationSchema = z.object({
  status: z.enum(["completed", "invalid_output", "unavailable", "skipped"]),
  publish: z.boolean(),
  reason_code: z.enum(ARBITER_REASON_CODES).nullable(),
  value: z
    .union([z.number().finite(), z.string().regex(/^\d{1,9}(?:\.\d{1,4})?$/u)])
    .transform(Number),
  prompt_version: z.string(),
});
export type AutoPublicationArbitration = z.output<typeof autoPublicationArbitrationSchema>;

/** Données lues pour un fait candidat. `null` : la donnée n'a pas pu être lue (échec fermé). */
export type AutoPublicationInput = {
  candidate: {
    factKey: string;
    status: string;
    evidenceAssetId: string | null;
    /** Nature de la pièce du fait (`email_body` : corps du message relu par l'IA) ; null si illisible. */
    evidenceKind?: string | null;
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
  informationCase: {
    sentAt: string | null;
    recipientKind: string | null;
    status: string | null;
    metadata: unknown;
  } | null;
  /** Le destinataire du dossier est opposé (registre des contacts) ; null si illisible. */
  contactOpposed: boolean | null;
  sale: {
    propertyType: string | null;
    surfaceM2: number | null;
    appSurfaceM2: number | null;
    habitableSurfaceM2: number | null;
    carrezSurfaceM2: number | null;
    /** Nature de la surface retenue et périmètre (« land » : surface du terrain, voir `isLandOnlySurface`). */
    appSurfaceKind: string | null;
    surfaceScope: string | null;
    landSurfaceM2: number | null;
    roomsCount: number | null;
    /** `quality_flags` et `raw_payload.source_lot_selection` de la vente (vente à un seul lot). */
    qualityFlags: unknown;
    sourceLotSelection: unknown;
  } | null;
  /** Nombre d'autres candidats du même message pour la même clé (toute provenance, tout statut). */
  otherCandidatesForKey: number | null;
  /** Nombre d'autres candidats en attente pour la même vente et la même clé, avec une autre valeur. */
  otherValuesForSale: number | null;
  /** Autres messages entrants du dossier, avant ou après celui du fait. */
  otherMessages: AutoPublicationOtherMessage[] | null;
  /** Dernier verdict de Haiku pour ce fait : `{ found: false }` s'il n'y en a pas ; null si illisible. */
  arbitration: { found: false } | { found: true; row: unknown } | null;
  /** Un autre fait a déjà « rempli » ce champ de la vente (simulé ou publié). */
  fieldFilledInSimulation: boolean | null;
  /**
   * Une analyse du message (pièce jointe, ou corps relu par l'IA) est en file, en cours ou en échec avec des essais
   * restants : ce que dit le message n'est pas encore tout lu. Null si illisible.
   */
  messageAnalysisPending: boolean | null;
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

/**
 * Champ vide sur la fiche. Surface : aucune des colonnes que la fiche peut afficher (règle d'affichage
 * `getRecordedSurface` : surface retenue, habitable, Carrez) ni la surface de l'annonce, et aucune valeur,
 * même nulle ou négative, dans ces colonnes.
 */
function fieldIsEmpty(
  field: AutoPublicationEligibleField,
  sale: NonNullable<AutoPublicationInput["sale"]>,
): boolean {
  if (field === "surface_m2") {
    return (
      getRecordedSurface({
        app_surface_m2: sale.appSurfaceM2,
        habitable_surface_m2: sale.habitableSurfaceM2,
        carrez_surface_m2: sale.carrezSurfaceM2,
      }) == null &&
      [sale.surfaceM2, sale.appSurfaceM2, sale.habitableSurfaceM2, sale.carrezSurfaceM2].every(
        (value) => value == null,
      )
    );
  }
  if (field === "land_surface_m2") {
    // Terrain nu : la fiche affiche la surface retenue comme surface du terrain quand celle du terrain
    // manque (règle d'affichage `getDisplaySurface`) ; le champ n'est alors pas vide.
    return (
      sale.landSurfaceM2 == null &&
      getDisplaySurface({
        property_type: sale.propertyType,
        app_surface_m2: sale.appSurfaceM2,
        app_surface_kind: sale.appSurfaceKind,
        surface_scope: sale.surfaceScope,
        habitable_surface_m2: sale.habitableSurfaceM2,
        carrez_surface_m2: sale.carrezSurfaceM2,
        land_surface_m2: sale.landSurfaceM2,
        rooms_count: sale.roomsCount,
      }).kind !== "land"
    );
  }
  return sale.roomsCount == null;
}

/**
 * Un message traité sans motif de relecture bloquant : traité sans motif, ou en relecture pour le seul motif
 * générique ; pour un autre message du dossier, une réponse automatique ignorée aussi.
 */
function processedForPublication(metadata: unknown, ownMessage: boolean): boolean {
  const processing = record(record(metadata)?.inbound_processing);
  if (!processing) return false;
  if (processing.status === "completed") return processing.reason == null;
  if (processing.status === "review") {
    return (
      typeof processing.reason === "string" &&
      NON_BLOCKING_INBOUND_REVIEW_REASONS.has(processing.reason)
    );
  }
  return !ownMessage && processing.status === "ignored" && processing.reason === "auto_reply";
}

/**
 * Vente à un seul lot : ni le signal `multi_lot_sale`, ni une sélection de lot dans l'annonce. Même règle que la
 * RPC de publication et la décision automatique du registre (migration 20261211100000), plus stricte que
 * `saleLotContext` (une sélection, même incomplète, suffit).
 */
export function isSingleLotSale(qualityFlags: unknown, sourceLotSelection: unknown): boolean {
  const flags = Array.isArray(qualityFlags) ? qualityFlags : [];
  return !flags.includes("multi_lot_sale") && sourceLotSelection == null;
}

/** Dossier ouvert à la publication : répondu ou en relecture, sans opposition reçue. */
function caseOpenForPublication(status: string | null, metadata: unknown): boolean {
  return (
    (status === "replied" || status === "review") &&
    record(metadata)?.last_inbound_contact_opposed !== true
  );
}

function textOf(parts: Array<string | null>): string {
  return parts.filter((part): part is string => typeof part === "string").join("\n");
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
    if (!processedForPublication(messageMetadata, true)) reasons.add("reply_in_review");
    if (typeof message.bodyText !== "string") {
      reasons.add("input_unreadable");
    } else {
      // Objet et corps : une consigne ou une demande de ne pas publier peut être dans l'objet.
      const text = textOf([message.subject, message.bodyText]);
      if (text.length > AUTO_PUBLICATION_MAX_ANALYZED_TEXT_CHARS) {
        reasons.add("input_unreadable");
      } else {
        if (detectPossiblePromptInjection(text)) reasons.add("possible_manipulation");
        if (mentionsDoNotPublish(text)) reasons.add("do_not_publish_requested");
      }
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
  if (
    informationCase &&
    !caseOpenForPublication(informationCase.status, informationCase.metadata)
  ) {
    reasons.add("case_not_replied");
  }
  if (input.contactOpposed === null) reasons.add("input_unreadable");
  else if (input.contactOpposed) reasons.add("contact_opposed");

  // Autres messages du dossier : en relecture bloquante, en cours, opposés ou qui demandent de ne pas publier.
  if (
    input.otherMessages === null ||
    input.otherMessages.some(
      (other) =>
        textOf([other.subject, other.bodyText]).length > AUTO_PUBLICATION_MAX_ANALYZED_TEXT_CHARS,
    )
  ) {
    reasons.add("input_unreadable");
  } else {
    for (const other of input.otherMessages) {
      const action = record(other.metadata)?.admin_handled_action;
      if (
        !processedForPublication(other.metadata, false) ||
        action === "record_opposition" ||
        action === "wrong_recipient" ||
        mentionsDoNotPublish(textOf([other.subject, other.bodyText]))
      ) {
        reasons.add(other.after ? "later_message_in_case" : "other_message_in_case");
      }
    }
  }

  // 2. Corps du message lu par les règles, jamais une pièce jointe ni l'IA seule.
  if (candidate.evidenceAssetId !== null) {
    if (candidate.evidenceKind === "email_body") reasons.add("semantic_only_body");
    else if (candidate.evidenceKind == null) reasons.add("input_unreadable");
    else reasons.add("attachment_source");
  }
  if (!record(candidate.metadata)) reasons.add("input_unreadable");
  // Toutes les analyses du message sont finies : une pièce jointe encore à lire peut contredire le corps.
  if (input.messageAnalysisPending === null) reasons.add("input_unreadable");
  else if (input.messageAnalysisPending) reasons.add("evidence_pending");

  // 3. Aucune autre valeur pour ce champ, ni dans la réponse ni pour la vente.
  if (input.otherCandidatesForKey === null) reasons.add("input_unreadable");
  else if (input.otherCandidatesForKey > 0) reasons.add("other_value_in_reply");
  if (input.otherValuesForSale === null) reasons.add("input_unreadable");
  else if (input.otherValuesForSale > 0) reasons.add("other_value_for_sale");

  // 4. Champ vide sur la fiche, valeur plausible pour le type de bien, vente à un seul lot.
  const value = proposedNumber(candidate.proposedValue);
  if (!sale) {
    reasons.add("input_unreadable");
  } else {
    if (field) {
      if (!fieldIsEmpty(field, sale)) reasons.add("field_not_empty");
      if (value === null || !isPlausibleValue(field, sale.propertyType, value)) {
        reasons.add("implausible_value");
      }
    }
    if (!isSingleLotSale(sale.qualityFlags, sale.sourceLotSelection)) {
      reasons.add("multi_lot_sale");
    }
  }
  if (input.fieldFilledInSimulation === null) reasons.add("input_unreadable");
  else if (input.fieldFilledInSimulation) reasons.add("field_already_filled_in_simulation");

  // 5. Verdict de Haiku : « publier », pour cette valeur, avec le prompt courant.
  const arbitration = readArbitration(input.arbitration);
  if (arbitration === "unreadable") reasons.add("input_unreadable");
  else if (arbitration === "invalid") reasons.add("arbiter_unavailable");
  else if (
    arbitration === null ||
    arbitration.prompt_version !== AUTO_PUBLICATION_ARBITER_VERSION
  ) {
    reasons.add("arbiter_pending");
  } else if (arbitration.status !== "completed") reasons.add("arbiter_unavailable");
  else if (!arbitration.publish) reasons.add("arbiter_declined");
  else if (value === null || arbitration.value !== value) reasons.add("arbiter_value_mismatch");

  if (reasons.size === 0) return { outcome: "would_publish", reasons: [] };
  return { outcome: "review", reasons: [...reasons] };
}

/** Verdict lu : absent (null), illisible (lecture en échec), invalide (forme refusée par zod) ou validé. */
function readArbitration(
  arbitration: AutoPublicationInput["arbitration"],
): AutoPublicationArbitration | null | "unreadable" | "invalid" {
  if (arbitration === null) return "unreadable";
  if (!arbitration.found) return null;
  const parsed = autoPublicationArbitrationSchema.safeParse(arbitration.row);
  return parsed.success ? parsed.data : "invalid";
}

/** Libellé lisible du motif d'un verdict de Haiku ; un code inconnu reste signalé. */
export function autoPublicationArbiterReasonLabel(reason: string | null): string | null {
  if (reason === null) return null;
  return Object.hasOwn(AUTO_PUBLICATION_ARBITER_REASON_LABELS, reason)
    ? AUTO_PUBLICATION_ARBITER_REASON_LABELS[reason as AutoPublicationArbiterReason]
    : "motif non reconnu";
}

export type AutoPublicationPlanItem = {
  factId: string;
  caseId: string;
  saleId: string;
  factKey: string;
  input: AutoPublicationInput;
};

/**
 * État de la simulation hors du lot à décider. Un fait déjà « publié » en simulation un jour antérieur
 * (dernière décision « aurait été publié » avant aujourd'hui, heure de Paris) sort du lot : il a été compté
 * dans le plafond de son jour, il compte dans celui de son dossier et son champ est rempli.
 */
export type AutoPublicationCounters = {
  /** Faits hors du lot « publiés » aujourd'hui (heure de Paris). */
  today: number;
  /** Faits hors du lot « publiés », par dossier, toutes dates. */
  byCase: ReadonlyMap<string, number>;
  /** Champs déjà remplis par un fait hors du lot, clé `vente:champ`. */
  filled: ReadonlySet<string>;
};

/**
 * Décisions d'un lot de faits, dans l'ordre donné (le plus ancien d'abord), avec les plafonds : un fait qui
 * passerait toutes les conditions devient « relecture » si le plafond du jour ou du dossier est atteint.
 * Les compteurs et les champs remplis avancent au fil du lot. Chaque décision n'est calculée qu'à la demande
 * (générateur) : l'appelant vérifie son budget de temps avant de demander la suivante.
 */
export function* planAutoPublicationDecisions(
  items: AutoPublicationPlanItem[],
  counters: AutoPublicationCounters | null,
): Generator<
  { item: AutoPublicationPlanItem; decision: AutoPublicationDecision },
  void,
  undefined
> {
  let today = counters?.today ?? 0;
  const byCase = new Map(counters?.byCase ?? []);
  const filled = new Set(counters?.filled ?? []);
  for (const item of items) {
    const fieldKey = `${item.saleId}:${item.factKey}`;
    const base = decideAutoPublication({
      ...item.input,
      readFailed: item.input.readFailed || counters === null,
      fieldFilledInSimulation:
        item.input.fieldFilledInSimulation === null ? null : filled.has(fieldKey),
    });
    if (base.outcome !== "would_publish") {
      yield { item, decision: base };
      continue;
    }
    const reasons: AutoPublicationReason[] = [];
    if (today >= AUTO_PUBLICATION_DAILY_CAP) reasons.push("daily_cap_reached");
    if ((byCase.get(item.caseId) ?? 0) >= AUTO_PUBLICATION_CASE_CAP) {
      reasons.push("case_cap_reached");
    }
    if (reasons.length) {
      yield { item, decision: { outcome: "review", reasons } };
      continue;
    }
    today += 1;
    byCase.set(item.caseId, (byCase.get(item.caseId) ?? 0) + 1);
    filled.add(fieldKey);
    yield { item, decision: base };
  }
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
