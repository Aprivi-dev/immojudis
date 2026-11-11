import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import type { AuctionSale } from "@/lib/types";
import type {
  InformationAgentAddressObserver,
  InformationAgentAddressSourceKind,
} from "@/lib/information-agent-compliance";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import { findEmailsInText, replaceEmailsInText } from "@/lib/information-agent/email-in-text";
import {
  INFORMATION_AGENT_EXCLUDED_ADDRESS_MESSAGE,
  informationAgentExcludedAddressReason,
  isInformationAgentExcludedAddress,
} from "@/lib/information-agent/excluded-addresses";
import {
  informationAgentAddressKind,
  informationAgentStructureKeys,
  isInformationAgentStructureKey,
  ownMailDomainOf,
  type InformationAgentAddressKind,
  type InformationAgentStructureKind,
} from "@/lib/information-agent/contact-structure";
import {
  informationAgentListingBlockRole,
  isInterlocutorRoleForSale,
  isNonInterlocutorMention,
  readInformationAgentOrganizerType,
  type InformationAgentListingBlockName,
  type InformationAgentListingContactBlock,
  type InformationAgentOrganizerType,
} from "@/lib/information-agent/listing-contacts";

export { normalizedEmail };
export {
  INFORMATION_AGENT_EXCLUDED_ADDRESS_MESSAGE,
  informationAgentExcludedAddressReason,
  isCourtRegistryEmail,
  isInformationAgentExcludedAddress,
} from "@/lib/information-agent/excluded-addresses";

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
};

type InformationAgentContactRegistryRow =
  Database["public"]["Tables"]["information_agent_contacts"]["Row"];

export type InformationAgentContactRegistryBlock = Pick<
  InformationAgentContactRegistryRow,
  "scope_sale_id" | "opposition_status" | "bounce_status"
>;

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

/** Score d'une adresse qu'un bloc de contact de l'annonce associe à l'interlocuteur de la vente. */
const LISTING_BLOCK_SCORE = 100;
/** Score d'un bloc `contact` dont le rôle n'est pas établi : jamais choisi seul devant un interlocuteur désigné. */
const LISTING_PLAIN_CONTACT_SCORE = 76;
/** Écart qui fait choisir un contact seul (`selectInformationAgentContact`). */
const SELECTION_MARGIN = 12;
const LISTING_BLOCK_NAMES: readonly InformationAgentListingBlockName[] = [
  "contact",
  "manager",
  "lawyer",
];

/**
 * Même lecture que `discoverInformationAgentContacts`, avec le compte des adresses écartées et leur motif.
 *
 * Trois lectures, dans cet ordre :
 * 1. les blocs de contact de l'annonce (`source_property_features` : notaire, service de l'État, avocat),
 *    avec le rôle que la vente leur donne (`informationAgentListingBlockRole`) ;
 * 2. le champ `lawyer_contact`, les blocs cités et les descriptions ;
 * 3. le registre interne (adresses relevées par le pipeline).
 * Puis la règle de préférence : dans une même structure, l'adresse générique passe devant la nominative.
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
  /** Adresses d'une même structure : clé de groupe (bloc de l'annonce ou domaine propre) vers adresses. */
  const groups = new Map<string, Set<string>>();
  const group = (key: string, email: string) => {
    const members = groups.get(key) ?? new Set<string>();
    members.add(email);
    groups.set(key, members);
  };

  // 1. Blocs de contact de l'annonce.
  const blocks = sale.listing_contact_blocks ?? [];
  const lawyerAddresses = new Set([
    ...extractEmails(sale.lawyer_contact),
    ...blocks.flatMap((block) => block.lawyer.map((record) => record.email)),
  ]);
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
        if (informationAgentAddressKind(record.email) === "nominative" && !record.principal) {
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
          score:
            listingRole.role === "source_contact"
              ? LISTING_PLAIN_CONTACT_SCORE
              : LISTING_BLOCK_SCORE + 4,
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
  // Écartée partout, y compris si un bloc cité ou une description la répète.
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
    score: 100,
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
      // `lawyer_contact` porte le contact de l'organisateur de la vente, quel qu'il soit : le pipeline y
      // projette aussi celui du notaire ou du service de l'État. Son rôle est donc celui de l'organisateur.
      const organizerRole = observation.kind === "sale_field" ? saleFieldRole(organizerType) : null;
      const role =
        organizerRole?.role ?? inferContactRole(`${observation.field} ${observation.value}`);
      if (observation.kind !== "sale_field") {
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
        structureKind: organizerRole?.structureKind ?? null,
        officeCode: null,
        score: observation.score + (role === "source_contact" ? 0 : 4),
        provenance: {
          kind: observation.kind,
          field: observation.field,
          sourceName: observation.sourceName,
          sourceUrl: observation.sourceUrl,
        },
      });
    }
  }

  // 3. Registre interne.
  addRegistryContacts(
    byEmail,
    (sale.registry_contacts ?? []).filter((contact) => {
      const email = normalizedEmail(contact.email);
      return !email || !barred.has(email);
    }),
  );

  for (const candidate of byEmail.values()) {
    candidate.addressKind = informationAgentAddressKind(candidate.email);
    const domain = ownMailDomainOf(candidate.email);
    if (domain) group(`domain|${domain}`, candidate.email);
  }
  for (const members of groups.values()) preferGenericAddress(byEmail, members);

  return {
    candidates: [...byEmail.values()].sort(
      (left, right) => right.score - left.score || left.email.localeCompare(right.email),
    ),
    refused,
  };
}

/** Rôle du contact porté par `lawyer_contact` : celui de l'organisateur de la vente ; `null` : avocat (inféré). */
function saleFieldRole(organizerType: InformationAgentOrganizerType): {
  role: InformationAgentContactRole;
  structureKind: InformationAgentStructureKind;
} | null {
  if (organizerType === "notary") return { role: "notary", structureKind: "notary_office" };
  if (organizerType === "state_service") {
    return { role: "organizer", structureKind: "state_service" };
  }
  return null;
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
  if (!current.name && observed.name) current.name = observed.name;
}

/**
 * Règle de préférence dans une même structure (même bloc de l'annonce ou même domaine propre) : s'il existe
 * une adresse générique et une adresse nominative, la meilleure adresse générique passe devant la meilleure
 * nominative, avec l'écart qui la fait choisir seule. Elle prend le rôle de la structure quand le sien n'était
 * pas établi. Le nom du professionnel reste attaché à son adresse nominative, pas à l'adresse générique.
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
  if (generic.role === "source_contact" && nominative.role !== "source_contact") {
    generic.role = nominative.role;
    generic.recipientKind = nominative.recipientKind;
    if (nominative.structureKind) generic.structureKind = nominative.structureKind;
    if (nominative.officeCode) generic.officeCode = nominative.officeCode;
  }
  const preferred = nominative.score + SELECTION_MARGIN;
  if (generic.score < preferred) {
    generic.score = preferred;
    generic.confidence = confidenceForContactScore(preferred);
  }
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
    const role: InformationAgentContactRole =
      contact.role === "lawyer" || contact.role === "notary" || contact.role === "organizer"
        ? contact.role
        : "source_contact";
    const sourceUrl = safeSourceUrlOrNull(contact.sourceUrl);
    const provenance: InformationAgentContactProvenance = {
      kind: "source_block",
      field: "information_agent_contacts",
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
    const score = 100 + (role === "source_contact" ? 0 : 4);
    const structureKind: InformationAgentStructureKind | null =
      role === "lawyer" ? "law_firm" : role === "notary" ? "notary_office" : null;
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
  if (second && first.score - second.score < 12) return null;
  return first;
}

/**
 * Returns whether a registry row blocks contact for the requested sale.
 * Global rows (scope_sale_id null) apply to every sale; sale-scoped rows keep
 * their original scope even after sale_id is nulled by retention. Unknown or
 * merely unverified rows remain contactable so the supervised workflow can
 * ask an admin to decide.
 */
export function isInformationAgentContactBlocked(
  row: InformationAgentContactRegistryBlock,
  saleId?: string | null,
): boolean {
  const appliesToSale = row.scope_sale_id === null || row.scope_sale_id === (saleId ?? null);
  return (
    appliesToSale && (row.opposition_status === "opposed" || row.bounce_status === "permanent")
  );
}

/**
 * Reads only the two registry scopes that can apply to this sale. Keeping the
 * scope predicates in PostgREST means a large number of unrelated sales can
 * never consume the response limit before a global opposition is returned.
 * A database error is intentionally propagated so an unavailable control
 * plane cannot turn into an implicit permission to contact someone.
 */
export async function loadInformationAgentContactRegistry(
  email: string,
  saleId?: string | null,
): Promise<InformationAgentContactRegistryBlock[]> {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error("Adresse email du contact invalide.");

  const selectRegistryRows = () =>
    supabaseAdmin
      .from("information_agent_contacts")
      .select("scope_sale_id, opposition_status, bounce_status")
      .eq("normalized_email", normalized);

  const queries = [selectRegistryRows().is("scope_sale_id", null)];
  if (saleId !== null && saleId !== undefined) {
    queries.push(selectRegistryRows().eq("scope_sale_id", saleId));
  }

  const results = await Promise.all(queries);
  const rows: InformationAgentContactRegistryBlock[] = [];
  for (const { data, error } of results) {
    if (error) throw error;
    if (!data) throw new Error("Registre des contacts indisponible.");
    rows.push(...data);
  }
  return rows;
}

/**
 * Stores source observations without changing a row that is already in the
 * registry. In particular, a later scrape must never clear an opposition,
 * bounce, or verification decision made by an operator.
 */
export async function persistInformationAgentContactObservations({
  saleId,
  candidates,
}: {
  saleId: string;
  candidates: readonly InformationAgentContactCandidate[];
}): Promise<void> {
  const byEmail = new Map<string, InformationAgentContactCandidate>();
  for (const candidate of candidates) {
    const email = normalizedEmail(candidate.email);
    if (email && !byEmail.has(email)) byEmail.set(email, { ...candidate, email });
  }
  const observedAt = new Date().toISOString();
  const rows = [...byEmail.values()].map((candidate) => {
    const listingUrl = candidate.provenance.find((item) => item.sourceUrl)?.sourceUrl ?? null;
    const source: InformationAgentContactSource = candidate.source ?? {
      kind: "sale_listing",
      url: listingUrl,
      observedAt,
      observedBy: "agent",
    };
    return {
      sale_id: saleId,
      scope_sale_id: saleId,
      email: candidate.email,
      display_name: candidate.name,
      role: candidate.role,
      provenance: candidate.provenance.map((item) => ({
        kind: item.kind,
        field: item.field,
        source_name: item.sourceName,
        source_url: item.sourceUrl,
      })),
      verification_status: "source_observed" as const,
      opposition_status: "unknown" as const,
      bounce_status: "none" as const,
      source_name: candidate.provenance.find((item) => item.sourceName)?.sourceName ?? null,
      source_url: source.url,
      source_kind: source.kind,
      source_directory_name: source.kind === "official_directory" ? source.directoryName : null,
      observed_at: source.observedAt,
      observed_by: source.observedBy,
      observed_by_user_id: source.observedByUserId ?? null,
      identity_keys: candidate.identityKeys ?? [],
      metadata: {
        observation_channel: "information_agent_draft",
        confidence: candidate.confidence,
        score: candidate.score,
        ...(candidate.matchRule ? { match_rule: candidate.matchRule } : {}),
        ...(candidate.structureKind ? { structure_kind: candidate.structureKind } : {}),
        ...(candidate.addressKind ? { address_kind: candidate.addressKind } : {}),
        ...(candidate.officeCode ? { office_code: candidate.officeCode } : {}),
      },
      last_seen_at: observedAt,
    };
  });
  if (!rows.length) return;
  const { error } = await supabaseAdmin.from("information_agent_contacts").upsert(rows, {
    onConflict: "scope_sale_id,normalized_email",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

/**
 * Enregistre une opposition globale (toutes ventes) pour une adresse : utilisée quand une réponse
 * consignée par un administrateur ou un dépôt du portail demande de ne plus être contacté. Une
 * opposition ne s'efface jamais par ce chemin.
 */
export async function recordInformationAgentContactOpposition({
  email,
  opposedAt = new Date().toISOString(),
}: {
  email: string;
  opposedAt?: string;
}): Promise<void> {
  const normalized = normalizedEmail(email);
  if (!normalized) return;
  const { error } = await supabaseAdmin.from("information_agent_contacts").upsert(
    {
      sale_id: null,
      scope_sale_id: null,
      email: normalized,
      opposition_status: "opposed",
      opposed_at: opposedAt,
    },
    { onConflict: "scope_sale_id,normalized_email" },
  );
  if (error) throw error;
}

/**
 * Guard used both when a draft chooses a recipient and immediately before
 * approval. It covers the race where a contact opts out or permanently
 * bounces after a draft was created.
 */
export async function assertInformationAgentContactAllowed({
  email,
  saleId,
  identityKeys = [],
  structureKeys = [],
  courtRegistryAddress = false,
}: {
  email: string;
  saleId?: string | null;
  /** Clés d'identité du professionnel : une opposition vaut sous toute autre adresse. */
  identityKeys?: readonly string[];
  /**
   * Clés de la structure du destinataire (`informationAgentStructureKeys`) : une opposition enregistrée pour
   * la structure vaut pour toutes ses adresses, génériques ou nominatives.
   */
  structureKeys?: readonly string[];
  /**
   * L'adresse est celle du greffe du référentiel des tribunaux, vérifiée par l'appelant
   * (`assertCourtRegistryFallbackAddress`) : seule l'exclusion `court` est levée, pour cette adresse.
   * RPVA, Ordre, CARPA, adresses techniques, opposition et rebond restent contrôlés.
   */
  courtRegistryAddress?: boolean;
}): Promise<void> {
  const excludedReason = informationAgentExcludedAddressReason(email);
  if (excludedReason !== null && !(courtRegistryAddress && excludedReason === "court")) {
    throw new Error(INFORMATION_AGENT_EXCLUDED_ADDRESS_MESSAGE);
  }
  const rows = await loadInformationAgentContactRegistry(email, saleId);
  if (rows.some((row) => isInformationAgentContactBlocked(row, saleId))) {
    throw new Error(
      "Le contact est explicitement opposé ou en rebond permanent ; aucune sollicitation n'est autorisée.",
    );
  }
  const opposed = await loadOpposedInformationAgentIdentityKeys([
    ...identityKeys,
    ...structureKeys,
  ]);
  if (opposed.some(isInformationAgentStructureKey)) {
    throw new Error(INFORMATION_AGENT_STRUCTURE_OPPOSED_MESSAGE);
  }
  if (opposed.length) throw new Error(INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE);
}

export const INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE =
  "Ce professionnel s'est opposé à être contacté (opposition enregistrée sous une autre adresse) ; aucune sollicitation n'est autorisée.";

export const INFORMATION_AGENT_STRUCTURE_OPPOSED_MESSAGE =
  "Cette structure (cabinet, office ou service) s'est opposée à être contactée ; aucune de ses adresses n'est sollicitée.";

export const INFORMATION_AGENT_STRUCTURE_UNKNOWN_MESSAGE =
  "Aucune structure identifiable pour cette adresse (domaine partagé ou messagerie grand public, sans code d'office) : enregistrez l'opposition pour l'adresse.";

/**
 * Enregistre une opposition pour toute la structure : code d'office notarial ou domaine PROPRE du cabinet.
 * Elle va dans la liste d'opposition par identité (aucune adresse, jamais purgée) et vaut pour toutes les
 * adresses de la structure. Un domaine partagé (`notaires.fr`, `gouv.fr`) ou une messagerie grand public
 * n'identifie aucune structure : refus, l'opposition se fait alors par adresse. Jamais effacée par ce chemin.
 */
export async function recordInformationAgentStructureOpposition({
  email,
  officeCode,
  opposedAt = new Date().toISOString(),
}: {
  email: string;
  officeCode?: string | null;
  opposedAt?: string;
}): Promise<string[]> {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error("Adresse email du contact invalide.");
  const keys = informationAgentStructureKeys({ email: normalized, officeCode });
  if (!keys.length) throw new Error(INFORMATION_AGENT_STRUCTURE_UNKNOWN_MESSAGE);
  const { error } = await supabaseAdmin.from("information_agent_identity_oppositions").upsert(
    keys.map((identity_key) => ({ identity_key, opposed_at: opposedAt })),
    { onConflict: "identity_key", ignoreDuplicates: true },
  );
  if (error) throw error;
  return keys;
}

/**
 * Clés d'identité qui figurent dans la liste d'opposition. Une erreur de base est propagée : un
 * contrôle indisponible ne vaut jamais autorisation.
 */
export async function loadOpposedInformationAgentIdentityKeys(
  identityKeys: readonly string[],
): Promise<string[]> {
  const keys = [...new Set(identityKeys.filter((key) => key.trim().length > 0))];
  if (!keys.length) return [];
  const { data, error } = await supabaseAdmin
    .from("information_agent_identity_oppositions")
    .select("identity_key")
    .in("identity_key", keys);
  if (error) throw error;
  if (!data) throw new Error("Liste d'opposition par identité indisponible.");
  return data.map((row) => row.identity_key);
}

/**
 * Contrôle d'opposition par identité, à appeler avant toute recherche d'adresse et avant l'envoi.
 * Sans clé (identité insuffisante), seule l'opposition par adresse s'applique.
 */
export async function assertInformationAgentIdentityAllowed(
  identityKeys: readonly string[],
): Promise<void> {
  if ((await loadOpposedInformationAgentIdentityKeys(identityKeys)).length) {
    throw new Error(INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE);
  }
}

/**
 * Enregistre l'adresse saisie par un administrateur, d'après une page publique, avec sa date et son
 * auteur. Une ligne déjà typée (annonce, annuaire…) n'est jamais réécrite ; seule l'URL d'une saisie
 * d'administrateur peut être complétée ou corrigée, la date de relevé restant celle de la saisie.
 */
export async function recordInformationAgentAdminAddressEntry({
  saleId,
  email,
  name,
  url,
  observedAt,
  adminId,
  identityKeys = [],
}: {
  saleId: string;
  email: string;
  name: string | null;
  url: string | null;
  observedAt: string;
  adminId: string;
  identityKeys?: readonly string[];
}): Promise<void> {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new Error("Adresse email du contact invalide.");
  const { data: existing, error: readError } = await supabaseAdmin
    .from("information_agent_contacts")
    .select("source_kind, source_url")
    .eq("normalized_email", normalized)
    .eq("scope_sale_id", saleId)
    .limit(1);
  if (readError) throw readError;
  const row = existing?.[0];
  if (!row) {
    const { error } = await supabaseAdmin.from("information_agent_contacts").upsert(
      {
        sale_id: saleId,
        scope_sale_id: saleId,
        email: normalized,
        display_name: name,
        role: "manual_professional",
        provenance: [{ kind: "admin_entry", field: "recipient_email", source_url: url }],
        verification_status: "unverified" as const,
        opposition_status: "unknown" as const,
        bounce_status: "none" as const,
        source_url: url,
        source_kind: "admin_entry" as const,
        observed_at: observedAt,
        observed_by: "admin" as const,
        observed_by_user_id: adminId,
        identity_keys: [...identityKeys],
        metadata: { observation_channel: "information_agent_admin_entry" },
        last_seen_at: observedAt,
      },
      { onConflict: "scope_sale_id,normalized_email", ignoreDuplicates: true },
    );
    if (error) throw error;
    return;
  }
  if (row.source_kind === "admin_entry" && url && row.source_url !== url) {
    const { error } = await supabaseAdmin
      .from("information_agent_contacts")
      .update({ source_url: url, identity_keys: [...identityKeys] })
      .eq("normalized_email", normalized)
      .eq("scope_sale_id", saleId);
    if (error) throw error;
  }
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
