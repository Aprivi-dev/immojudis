/**
 * Résolution des destinataires de l'agent d'information à partir des données déjà collectées d'une vente.
 * MODULE PUR : aucun accès réseau ni base. Le registre des contacts, les oppositions et les écritures sont
 * dans `contacts.ts`.
 */
import type { Json } from "@/integrations/supabase/types";
import type { AuctionSale } from "@/lib/types";
import type {
  InformationAgentAddressObserver,
  InformationAgentAddressSourceKind,
} from "@/lib/information-agent-compliance";
import {
  INFORMATION_AGENT_STRUCTURE_KIND_BY_ROLE,
  informationAgentAddressKind,
  type InformationAgentAddressKind,
  type InformationAgentStructureKind,
} from "@/lib/information-agent/contact-structure";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import { findEmailsInText, replaceEmailsInText } from "@/lib/information-agent/email-in-text";
import { isInformationAgentExcludedAddress } from "@/lib/information-agent/excluded-addresses";
import {
  informationAgentListingBlockRole,
  informationAgentSaleFieldRole,
  isInterlocutorRoleForSale,
  isNonInterlocutorMention,
  readInformationAgentOrganizerType,
  type InformationAgentListingBlockName,
  type InformationAgentListingContactBlock,
  type InformationAgentOrganizerType,
} from "@/lib/information-agent/listing-contacts";

export type InformationAgentRecipientKind =
  | "source_lawyer"
  | "source_contact"
  | "manual_professional";

export type InformationAgentContactRole = "lawyer" | "notary" | "organizer" | "source_contact";

export type InformationAgentContactProvenance = {
  kind: "sale_field" | "source_block" | "source_text" | "agent_search" | "court_registry";
  field: string;
  sourceName: string | null;
  sourceUrl: string | null;
};

/**
 * Source typée d'une adresse retenue (art. 14(2)(f) RGPD) : nature, URL exacte, date de relevé et
 * auteur. Une adresse lue dans les données de l'annonce (découverte actuelle) est une
 * `sale_listing` relevée par l'agent ; une recherche ultérieure fournit les autres types.
 */
export type InformationAgentContactSource = {
  kind: InformationAgentAddressSourceKind;
  /** Nom de l'annuaire, obligatoire pour `official_directory`. */
  directoryName?: string | null;
  url: string | null;
  observedAt: string;
  observedBy: InformationAgentAddressObserver;
  /** Administrateur auteur du relevé (`observedBy: "admin"`). */
  observedByUserId?: string | null;
};

export type InformationAgentContactCandidate = {
  email: string;
  name: string | null;
  role: InformationAgentContactRole;
  recipientKind: Extract<InformationAgentRecipientKind, "source_lawyer" | "source_contact">;
  confidence: "high" | "medium" | "low";
  score: number;
  provenance: InformationAgentContactProvenance[];
  /** Source typée ; par défaut l'annonce de la vente, relevée par l'agent à l'enregistrement. */
  source?: InformationAgentContactSource;
  /** Clés d'identité du professionnel (opposition par identité). */
  identityKeys?: string[];
  /** Règle d'appariement de la recherche automatique (`same_name_and_phone`, `generic`…). */
  matchRule?: string;
  /** Structure de l'interlocuteur, quand l'annonce la désigne (cabinet, office notarial, service de l'État). */
  structureKind?: InformationAgentStructureKind | null;
  /** Adresse générique de la structure ou adresse nominative (`contact-structure.ts`). */
  addressKind?: InformationAgentAddressKind;
  /** Code de l'office notarial publié par l'annonce (CRPCEN), pour un notaire seulement. */
  officeCode?: string | null;
};

/** Motifs pour lesquels une adresse présente dans l'annonce n'est pas retenue (comptages de la mesure à blanc). */
export type InformationAgentContactRefusal =
  | "excluded_address"
  | "not_sale_interlocutor"
  | "role_not_sale_interlocutor"
  | "nominative_other_person";

export type InformationAgentContactResolution = {
  candidates: InformationAgentContactCandidate[];
  /** Nombre d'adresses écartées, par motif. Aucune adresse. */
  refused: Partial<Record<InformationAgentContactRefusal, number>>;
  /** Organisateur de la vente retenu pour fixer les rôles. */
  organizerType: InformationAgentOrganizerType;
  /** Code d'office de la vente notariale, quand ses blocs n'en publient qu'un seul ; sinon `null`. */
  officeCode: string | null;
};

/** Champ de provenance d'une adresse lue au registre interne (relevée par le pipeline, jamais publiée). */
export const INFORMATION_AGENT_REGISTRY_PROVENANCE_FIELD = "information_agent_contacts";

/**
 * Canal d'observation des adresses que le pipeline relève pour l'agent sans jamais les publier
 * (email Licitor décodé, `metadata.observation_channel`). Miroir de `OBSERVATION_CHANNEL` dans
 * `services/data-pipeline/src/storage/internal_contacts.py`.
 */
export const INFORMATION_AGENT_PIPELINE_CHANNEL = "licitor_cloudflare_decoded";

/**
 * Adresse relevée par le pipeline et conservée uniquement dans le registre interne
 * (`information_agent_contacts`, service_role) : elle ne figure ni dans la vente ni dans ses blocs.
 */
export type InformationAgentRegistryContact = {
  email: string;
  displayName: string | null;
  role: string;
  sourceName: string | null;
  sourceUrl: string | null;
  observedAt: string | null;
};

/**
 * Vente lue par le résolveur ; `source_block_urls` (chargeur admin) précise l'URL de chaque bloc et
 * `registry_contacts` porte les adresses du registre interne pour cette vente.
 */
export type InformationAgentContactSale = AuctionSale & {
  source_block_urls?: Record<string, string | null> | null;
  registry_contacts?: readonly InformationAgentRegistryContact[] | null;
  /** Blocs de contact de `source_property_features` (vente et observations), lus par le chargeur admin. */
  listing_contact_blocks?: readonly InformationAgentListingContactBlock[] | null;
  /** `organizer_type` de la procédure de vente ; à défaut, lu dans `sale_procedure`. */
  information_agent_organizer_type?: InformationAgentOrganizerType | null;
};

/**
 * Finds contacts already present in the collected listing payload.
 *
 * This is deliberately source-data-only: it never performs a network lookup
 * and it keeps enough provenance for an admin to understand why a contact was
 * suggested before approving a request.
 */
export function discoverInformationAgentContacts(
  sale: InformationAgentContactSale,
): InformationAgentContactCandidate[] {
  return resolveInformationAgentListingContacts(sale).candidates;
}

/**
 * Score d'une adresse que l'annonce associe à l'interlocuteur de la vente : champ `lawyer_contact`, bloc de
 * contact de `source_property_features`, adresse du registre interne (relevée dans l'annonce par le pipeline).
 */
const LISTING_CONTACT_SCORE = 100;
/** Score d'un bloc `contact` dont le rôle n'est pas établi : jamais choisi seul devant un interlocuteur désigné. */
const LISTING_PLAIN_CONTACT_SCORE = 76;
/** Un rôle établi (avocat, notaire, organisateur) vaut quatre points de plus qu'un simple contact de l'annonce. */
const ESTABLISHED_ROLE_BONUS = 4;
/** Écart de score qui fait choisir un contact seul, et que la préférence générique donne à l'adresse générique. */
export const INFORMATION_AGENT_SELECTION_MARGIN = 12;
const LISTING_BLOCK_NAMES: readonly InformationAgentListingBlockName[] = [
  "contact",
  "manager",
  "lawyer",
];

function scoreForRole(base: number, role: InformationAgentContactRole): number {
  return base + (role === "source_contact" ? 0 : ESTABLISHED_ROLE_BONUS);
}

/**
 * Même lecture que `discoverInformationAgentContacts`, avec le compte des adresses écartées et leur motif.
 *
 * Trois lectures, dans cet ordre :
 * 1. les blocs de contact de l'annonce (`source_property_features` : notaire, service de l'État, avocat),
 *    avec le rôle que la vente leur donne (`informationAgentListingBlockRole`) ;
 * 2. le champ `lawyer_contact` (rôle : `informationAgentSaleFieldRole`), les blocs cités et les descriptions ;
 * 3. le registre interne (adresses relevées par le pipeline), filtré comme les blocs.
 * Puis deux règles : le code d'office unique d'une vente notariale vaut pour tous ses notaires, et dans un
 * même bloc de contact l'adresse générique passe devant la nominative.
 */
export function resolveInformationAgentListingContacts(
  sale: InformationAgentContactSale,
): InformationAgentContactResolution {
  const sourceName = cleanContactValue(sale.source_name ?? sale.primary_source);
  const sourceUrl = firstSourceUrl(sale);
  const organizerType =
    sale.information_agent_organizer_type ?? readInformationAgentOrganizerType(sale.sale_procedure);
  const refused: InformationAgentContactResolution["refused"] = {};
  const refuse = (reason: InformationAgentContactRefusal) => {
    refused[reason] = (refused[reason] ?? 0) + 1;
  };
  const byEmail = new Map<string, InformationAgentContactCandidate>();
  /**
   * Adresses données ensemble par l'annonce pour un même interlocuteur : un bloc de contact, ou le champ
   * `lawyer_contact`. Seul ce lien établit qu'une adresse générique est celle de la structure de la personne
   * nommée ; un domaine commun ou une mention dans un texte libre ne l'établit pas.
   */
  const groups = new Map<string, Set<string>>();
  const group = (key: string, email: string) => {
    const members = groups.get(key) ?? new Set<string>();
    members.add(email);
    groups.set(key, members);
  };

  // 1. Blocs de contact de l'annonce.
  const blocks = sale.listing_contact_blocks ?? [];
  const lawyerBlockAddresses = new Set(
    blocks.flatMap((block) => block.lawyer.map((record) => record.email)),
  );
  const lawyerAddresses = new Set([...extractEmails(sale.lawyer_contact), ...lawyerBlockAddresses]);
  const accepted = new Set<string>();
  const otherPeople = new Set<string>();
  blocks.forEach((block, blockIndex) => {
    for (const blockName of LISTING_BLOCK_NAMES) {
      for (const record of block[blockName]) {
        const listingRole = informationAgentListingBlockRole({
          block: blockName,
          organizerType,
          sourceName: block.sourceName,
          lawyerAddress: lawyerAddresses.has(record.email),
        });
        if (!listingRole) {
          refuse("role_not_sale_interlocutor");
          continue;
        }
        if (isInformationAgentExcludedAddress(record.email)) {
          refuse("excluded_address");
          continue;
        }
        // Adresse nominative d'une autre personne que le contact nommé par l'annonce : jamais retenue.
        if (record.addressKind === "nominative" && !record.principal) {
          otherPeople.add(record.email);
          continue;
        }
        accepted.add(record.email);
        group(`block|${blockIndex}|${blockName}`, record.email);
        upsertContactCandidate(byEmail, {
          email: record.email,
          name: record.name,
          role: listingRole.role,
          structureKind: listingRole.structureKind,
          officeCode: listingRole.role === "notary" ? block.officeCode : null,
          addressKind: record.addressKind,
          score: scoreForRole(
            listingRole.role === "source_contact"
              ? LISTING_PLAIN_CONTACT_SCORE
              : LISTING_CONTACT_SCORE,
            listingRole.role,
          ),
          provenance: {
            kind: "source_block",
            field: record.field,
            sourceName: block.sourceName ?? sourceName,
            sourceUrl: safeSourceUrlOrNull(block.sourceUrl) ?? sourceUrl,
          },
        });
      }
    }
  });
  // Écartée partout, y compris si un bloc cité, une description ou le registre la répète.
  const barred = new Set([...otherPeople].filter((email) => !accepted.has(email)));
  for (let index = 0; index < barred.size; index += 1) refuse("nominative_other_person");

  // 2. Champ de la vente, blocs cités et descriptions.
  const observations: ContactObservation[] = [];
  addContactObservation(observations, {
    value: sale.lawyer_contact,
    kind: "sale_field",
    field: "lawyer_contact",
    sourceName,
    sourceUrl,
    name: cleanContactValue(sale.lawyer_name),
    score: LISTING_CONTACT_SCORE,
  });

  collectSourceBlockContacts(
    observations,
    sale.source_blocks,
    "source_blocks",
    sourceName,
    sourceUrl,
  );
  collectSourceBlockContacts(
    observations,
    sale.source_blocks_by_source,
    "source_blocks_by_source",
    sourceName,
    sourceUrl,
    sale.source_block_urls ?? null,
  );

  addContactObservation(observations, {
    value: sale.source_description,
    kind: "source_text",
    field: "source_description",
    sourceName,
    sourceUrl,
    score: 42,
  });
  if (sale.description !== sale.source_description) {
    addContactObservation(observations, {
      value: sale.description,
      kind: "source_text",
      field: "description",
      sourceName,
      sourceUrl,
      score: 35,
    });
  }

  for (const observation of observations) {
    for (const email of extractEmails(observation.value)) {
      if (barred.has(email)) continue;
      if (isInformationAgentExcludedAddress(email)) {
        refuse("excluded_address");
        continue;
      }
      const saleField =
        observation.kind === "sale_field"
          ? informationAgentSaleFieldRole({
              organizerType,
              sourceName,
              lawyerAddress: lawyerBlockAddresses.has(email),
            })
          : null;
      const role = saleField?.role ?? inferContactRole(`${observation.field} ${observation.value}`);
      if (saleField) {
        group("sale_field", email);
      } else {
        if (isNonInterlocutorMention(observation.field, String(observation.value), email)) {
          refuse("not_sale_interlocutor");
          continue;
        }
        if (!isInterlocutorRoleForSale(role, organizerType)) {
          refuse("role_not_sale_interlocutor");
          continue;
        }
      }
      upsertContactCandidate(byEmail, {
        email,
        name: observation.name ?? null,
        role,
        structureKind: saleField?.structureKind ?? null,
        officeCode: null,
        score: scoreForRole(observation.score, role),
        provenance: {
          kind: observation.kind,
          field: observation.field,
          sourceName: observation.sourceName,
          sourceUrl: observation.sourceUrl,
        },
      });
    }
  }

  // 3. Registre interne, avec le même filtre de rôle que les blocs de l'annonce.
  addRegistryContacts(
    byEmail,
    (sale.registry_contacts ?? []).filter((contact) => {
      const email = normalizedEmail(contact.email);
      if (email && barred.has(email)) return false;
      if (!isInterlocutorRoleForSale(registryContactRole(contact), organizerType)) {
        refuse("role_not_sale_interlocutor");
        return false;
      }
      return true;
    }),
  );

  // Vente notariale dont les blocs ne publient qu'un seul code d'office : c'est l'office de la vente, donc
  // celui de tout notaire retenu, que son adresse vienne d'un bloc, du champ, d'un texte ou du registre.
  const publishedOfficeCodes = new Set(
    blocks.flatMap((block) => (block.officeCode ? [block.officeCode] : [])),
  );
  const officeCode =
    organizerType === "notary" && publishedOfficeCodes.size === 1
      ? ([...publishedOfficeCodes][0] ?? null)
      : null;
  for (const candidate of byEmail.values()) {
    candidate.addressKind ??= informationAgentAddressKind(candidate.email);
    if (officeCode && candidate.role === "notary") candidate.officeCode ??= officeCode;
  }
  for (const members of groups.values()) preferGenericAddress(byEmail, members);

  return {
    candidates: [...byEmail.values()].sort(
      (left, right) => right.score - left.score || left.email.localeCompare(right.email),
    ),
    refused,
    organizerType,
    officeCode,
  };
}

function recipientKindForRole(
  role: InformationAgentContactRole,
): InformationAgentContactCandidate["recipientKind"] {
  return role === "lawyer" ? "source_lawyer" : "source_contact";
}

/** Ajoute une adresse ou complète celle déjà connue : la meilleure observation fixe le score et le rôle. */
function upsertContactCandidate(
  byEmail: Map<string, InformationAgentContactCandidate>,
  observed: {
    email: string;
    name: string | null;
    role: InformationAgentContactRole;
    structureKind: InformationAgentStructureKind | null;
    officeCode: string | null;
    /** Nature désignée par l'annonce (boîte de service) ; absente : lue dans l'adresse à la fin. */
    addressKind?: InformationAgentAddressKind;
    score: number;
    provenance: InformationAgentContactProvenance;
  },
) {
  const current = byEmail.get(observed.email);
  if (!current) {
    byEmail.set(observed.email, {
      email: observed.email,
      name: observed.name,
      role: observed.role,
      recipientKind: recipientKindForRole(observed.role),
      confidence: confidenceForContactScore(observed.score),
      score: observed.score,
      provenance: [observed.provenance],
      ...(observed.structureKind ? { structureKind: observed.structureKind } : {}),
      ...(observed.officeCode ? { officeCode: observed.officeCode } : {}),
      ...(observed.addressKind ? { addressKind: observed.addressKind } : {}),
    });
    return;
  }
  if (!current.provenance.some((item) => sameContactProvenance(item, observed.provenance))) {
    current.provenance.push(observed.provenance);
  }
  if (observed.score > current.score) {
    current.score = observed.score;
    current.confidence = confidenceForContactScore(observed.score);
    current.role = observed.role;
    current.recipientKind = recipientKindForRole(observed.role);
    current.structureKind = observed.structureKind ?? undefined;
  } else if (!current.structureKind && observed.structureKind && current.role === observed.role) {
    current.structureKind = observed.structureKind;
  }
  if (!current.officeCode && observed.officeCode) current.officeCode = observed.officeCode;
  if (!current.addressKind && observed.addressKind) current.addressKind = observed.addressKind;
  if (!current.name && observed.name) current.name = observed.name;
}

/**
 * Règle de préférence entre les adresses que l'annonce donne ENSEMBLE pour un même interlocuteur (même bloc
 * de contact, ou champ `lawyer_contact`) : la meilleure adresse générique passe devant la meilleure
 * nominative, avec l'écart qui la fait choisir seule. Rien n'est transféré d'une adresse à l'autre : le rôle
 * de chacune vient du bloc, le nom du professionnel reste attaché à son adresse nominative.
 */
function preferGenericAddress(
  byEmail: Map<string, InformationAgentContactCandidate>,
  members: ReadonlySet<string>,
) {
  const ranked = [...members]
    .map((email) => byEmail.get(email))
    .filter((candidate): candidate is InformationAgentContactCandidate => Boolean(candidate))
    .sort((left, right) => right.score - left.score || left.email.localeCompare(right.email));
  const generic = ranked.find((candidate) => candidate.addressKind === "generic");
  const nominative = ranked.find((candidate) => candidate.addressKind === "nominative");
  if (!generic || !nominative) return;
  const preferred = nominative.score + INFORMATION_AGENT_SELECTION_MARGIN;
  if (generic.score < preferred) {
    generic.score = preferred;
    generic.confidence = confidenceForContactScore(preferred);
  }
}

/** Rôle d'une ligne du registre interne ; toute valeur hors liste vaut « contact de l'annonce ». */
function registryContactRole(
  contact: InformationAgentRegistryContact,
): InformationAgentContactRole {
  return contact.role === "lawyer" || contact.role === "notary" || contact.role === "organizer"
    ? contact.role
    : "source_contact";
}

/**
 * Adresses du registre interne pour cette vente (relevées par le pipeline, jamais publiées). Mêmes
 * exclusions que pour les données de l'annonce (juridiction, RPVA, Ordre, barreau, CARPA) ; l'origine
 * reste l'annonce (`sale_listing`), avec sa page et sa date de relevé pour le pied du message.
 */
function addRegistryContacts(
  byEmail: Map<string, InformationAgentContactCandidate>,
  contacts: readonly InformationAgentRegistryContact[],
) {
  for (const contact of contacts) {
    const email = normalizedEmail(contact.email);
    if (!email || isInformationAgentExcludedAddress(email)) continue;
    const role = registryContactRole(contact);
    const sourceUrl = safeSourceUrlOrNull(contact.sourceUrl);
    const provenance: InformationAgentContactProvenance = {
      kind: "source_block",
      field: INFORMATION_AGENT_REGISTRY_PROVENANCE_FIELD,
      sourceName: cleanContactValue(contact.sourceName),
      sourceUrl,
    };
    const source: InformationAgentContactSource | undefined = contact.observedAt
      ? {
          kind: "sale_listing",
          url: sourceUrl,
          observedAt: contact.observedAt,
          observedBy: "agent",
        }
      : undefined;
    const score = scoreForRole(LISTING_CONTACT_SCORE, role);
    const structureKind = INFORMATION_AGENT_STRUCTURE_KIND_BY_ROLE[role];
    const current = byEmail.get(email);
    if (!current) {
      byEmail.set(email, {
        email,
        name: cleanContactValue(contact.displayName),
        role,
        recipientKind: recipientKindForRole(role),
        confidence: confidenceForContactScore(score),
        score,
        provenance: [provenance],
        ...(source ? { source } : {}),
        ...(structureKind ? { structureKind } : {}),
      });
      continue;
    }
    if (!current.provenance.some((item) => sameContactProvenance(item, provenance))) {
      current.provenance.push(provenance);
    }
    if (!current.source && source) current.source = source;
    if (!current.name) current.name = cleanContactValue(contact.displayName);
  }
}

/**
 * Auto-selection is intentionally conservative. A tie between equally
 * plausible contacts must be resolved by an admin in the draft form.
 */
export function selectInformationAgentContact(
  candidates: readonly InformationAgentContactCandidate[],
): InformationAgentContactCandidate | null {
  const [first, second] = [...candidates].sort(
    (left, right) => right.score - left.score || left.email.localeCompare(right.email),
  );
  if (!first || first.confidence === "low") return null;
  if (second && first.score - second.score < INFORMATION_AGENT_SELECTION_MARGIN) return null;
  return first;
}

type ContactObservation = {
  value: unknown;
  kind: InformationAgentContactProvenance["kind"];
  field: string;
  sourceName: string | null;
  sourceUrl: string | null;
  name?: string | null;
  score: number;
};

function collectSourceBlockContacts(
  observations: ContactObservation[],
  value: unknown,
  rootField: string,
  sourceName: string | null,
  sourceUrl: string | null,
  blockUrls: Record<string, string | null> | null = null,
) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectSourceBlockContacts(
        observations,
        item,
        `${rootField}[${index}]`,
        sourceName,
        sourceUrl,
      ),
    );
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const field = `${rootField}.${key}`;
    const bySource = rootField === "source_blocks_by_source";
    // Clés « licitor:primary », « notaires:2 » : la source est avant les deux-points et l'URL est
    // celle de l'observation qui porte ce bloc, pas celle de l'annonce principale.
    const childSourceName = bySource ? key.split(":")[0] || sourceName : sourceName;
    const childSourceUrl = bySource
      ? (safeSourceUrlOrNull(blockUrls?.[key]) ?? sourceUrl)
      : sourceUrl;
    if (typeof child === "string") {
      addContactObservation(observations, {
        value: child,
        kind: "source_block",
        field,
        sourceName: childSourceName,
        sourceUrl: childSourceUrl,
        name: inferNameFromSourceBlock(child, field),
        score: contactScoreForField(field),
      });
      continue;
    }
    collectSourceBlockContacts(observations, child, field, childSourceName, childSourceUrl);
  }
}

function addContactObservation(
  observations: ContactObservation[],
  observation: ContactObservation,
) {
  if (typeof observation.value !== "string" || !observation.value.trim()) return;
  if (!extractEmails(observation.value).length) return;
  observations.push(observation);
}

function extractEmails(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [
    ...new Set(
      findEmailsInText(value)
        .map(normalizedEmail)
        .filter((email): email is string => Boolean(email)),
    ),
  ];
}

function inferContactRole(value: string): InformationAgentContactRole {
  const normalized = stripDiacritics(value).toLowerCase();
  if (/avocat|lawyer|cabinet/.test(normalized)) return "lawyer";
  // « étude » seule ne dit pas notaire : c'est aussi le mot d'un commissaire de justice.
  if (/notair|notari|notary/.test(normalized)) return "notary";
  if (/organisat|organizer|commissaire|vendeur/.test(normalized)) return "organizer";
  return "source_contact";
}

function inferNameFromSourceBlock(value: string, field: string): string | null {
  if (!/(?:nom|name|avocat|notaire|notary|organisateur|organizer)/i.test(field)) return null;
  const withoutEmail = replaceEmailsInText(value, " ");
  const candidate = withoutEmail
    .replace(/[|,:;()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return candidate.length >= 2 && candidate.length <= 180 ? candidate : null;
}

function contactScoreForField(field: string): number {
  const normalized = stripDiacritics(field).toLowerCase();
  if (/contact_avocat|lawyer_contact/.test(normalized)) return 96;
  if (/notair|notary/.test(normalized)) return 92;
  if (/organisat|organizer|commissaire/.test(normalized)) return 88;
  if (/(?:contact|email|mail)/.test(normalized)) return 76;
  return 52;
}

function confidenceForContactScore(score: number): InformationAgentContactCandidate["confidence"] {
  return score >= 90 ? "high" : score >= 70 ? "medium" : "low";
}

function sameContactProvenance(
  left: InformationAgentContactProvenance,
  right: InformationAgentContactProvenance,
): boolean {
  return (
    left.kind === right.kind &&
    left.field === right.field &&
    left.sourceName === right.sourceName &&
    left.sourceUrl === right.sourceUrl
  );
}

export function contactCandidateSnapshot(candidate: InformationAgentContactCandidate): Json {
  return {
    email: candidate.email,
    name: candidate.name,
    role: candidate.role,
    recipient_kind: candidate.recipientKind,
    confidence: candidate.confidence,
    score: candidate.score,
    structure_kind: candidate.structureKind ?? null,
    address_kind: candidate.addressKind ?? informationAgentAddressKind(candidate.email),
    office_code: candidate.officeCode ?? null,
    provenance: candidate.provenance.map((item) => ({
      kind: item.kind,
      field: item.field,
      source_name: item.sourceName,
      source_url: item.sourceUrl,
    })),
  };
}

function firstSourceUrl(sale: AuctionSale): string | null {
  const values: unknown[] = [sale.source_url, sale.source_urls];
  for (const value of values) {
    const candidate = firstUrl(value);
    if (candidate) return candidate;
  }
  return null;
}

function firstUrl(value: unknown): string | null {
  if (typeof value === "string") return safeSourceUrl(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = firstUrl(item);
      if (candidate) return candidate;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      const candidate = firstUrl(child);
      if (candidate) return candidate;
    }
  }
  return null;
}

function safeSourceUrlOrNull(value: unknown): string | null {
  return typeof value === "string" ? safeSourceUrl(value) : null;
}

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return null;
  }
}

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function cleanContactValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
