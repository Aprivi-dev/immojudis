import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  loadAdminInformationAgentSale,
  loadInformationAgentContactSales,
  type AdminInformationAgentSale,
} from "@/lib/admin-information-agent-sale";
import { readSaleFactClaims } from "@/lib/auction-fact-claims";
import { getFactReliabilitiesFromClaims } from "@/lib/fact-reliability";
import { buildInformationAgentInventory } from "@/lib/information-agent-inventory";
import { detectInformationGaps } from "@/lib/information-agent-questions";
import {
  checkMailDomain,
  informationAgentAddressCheckEnabled,
} from "@/lib/information-agent/address-deliverability";
import {
  informationAgentAddressHygieneIssue,
  isConsumerMailAddress,
  mailDomainOf,
} from "@/lib/information-agent/address-hygiene";
import {
  loadAutopilotAlreadyInformed,
  loadAutopilotFirstRecordedAt,
  loadAutopilotHistoryFacts,
  loadAutopilotRegistryFacts,
} from "@/lib/information-agent/autopilot-facts";
import {
  autopilotArt14Refusal,
  autopilotQueueRefusal,
  evaluateAutopilotCandidate,
  type AutopilotSettings,
} from "@/lib/information-agent/autopilot-rules";
import { loadExcludedIdentityKeys } from "@/lib/information-agent/autopilot-settings";
import {
  assertInformationAgentContactAllowed,
  persistInformationAgentContactObservations,
} from "@/lib/information-agent/contacts";
import {
  discoverInformationAgentContacts,
  INFORMATION_AGENT_PIPELINE_CHANNEL,
  resolveInformationAgentListingContacts,
  selectInformationAgentContact,
  type InformationAgentContactCandidate,
} from "@/lib/information-agent/contact-resolution";
import { informationAgentNotarySendClosed } from "@/lib/information-agent/config";
import {
  informationAgentQuestionAudience,
  informationAgentSaleAudience,
} from "@/lib/information-agent/recipient-questions";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import {
  personIdentityKeys,
  recipientOppositionKeys,
} from "@/lib/information-agent/opposition-keys";
import { saleIdentityPlace } from "@/lib/information-agent/mission-identity";

/**
 * Candidats du pilote automatique. Point de départ : la file de l'agent (RPC `admin_information_agent_queue`,
 * classe A), lue page par page. Chaque page passe d'abord un tri SANS EXAMEN COÛTEUX : sur la lecture légère de
 * l'annonce et du registre interne (`loadInformationAgentContactSales`, celle de la classe de contact), un contact
 * choisi seul par le résolveur (classe A), `autopilotQueueRefusal` (rôle, identité, messagerie, adresse Licitor
 * décodée selon le réglage, date de la vente) et la garde des envois aux notaires (vente notariale) ; puis, pour les
 * ventes restantes de la page, des lectures groupées (une par page, jamais une par vente) : brouillon d'un
 * administrateur, premier enregistrement de l'adresse et, pour les adresses hors délai, envois précédents
 * (article 14). Seules les ventes qui passent ce tri comptent parmi les `maxExamined` examens du passage :
 * vérification candidat par candidat, `evaluateAutopilotCandidate` (règles pures) sur des faits lus ici, qui reste la
 * garde finale. Jamais de recherche réseau d'adresse, jamais de greffe : seulement l'avocat dont l'adresse figure
 * dans l'annonce de la vente.
 */
export type AutopilotCandidate = {
  saleId: string;
  tribunalCode: string | null;
  email: string;
  domain: string;
  /** Code d'office publié par l'annonce (notaire) : unité de plafond sur un domaine partagé. */
  officeCode?: string | null;
  identityKeys: string[];
};

export type AutopilotCandidateSearch = {
  candidates: AutopilotCandidate[];
  /** Nombre de ventes écartées, par code de motif. */
  skipped: Record<string, number>;
  examined: number;
};

const SALE_BATCH = 100;
/** Lecture légère par paquets de 50 identifiants, comme la classe de contact (`classifyInformationAgentSaleContacts`). */
const CONTACT_SALES_CHUNK = 50;
/**
 * Ventes de la file lues au plus par passage : borne le coût d'une file dont la tête est refusée d'avance (10 pages,
 * soit par page une lecture de la file, deux lectures légères et les lectures groupées du tri). Les examens réels
 * restent bornés par `maxExamined`.
 */
const MAX_QUEUE_SCAN = 1000;

async function readQueuePage(offset: number): Promise<string[]> {
  const { data, error } = await supabaseAdmin.rpc("admin_information_agent_queue", {
    p_limit: SALE_BATCH,
    p_offset: offset,
    p_class: "A",
  });
  if (error) throw error;
  return ((data as { items?: Array<{ id: string }> } | null)?.items ?? []).map((item) => item.id);
}

/** Contact que le résolveur choisit seul dans l'annonce (adresses mal formées écartées si le contrôle est actif). */
function listingSelection(sale: AdminInformationAgentSale, checkAddresses: boolean) {
  return selectInformationAgentContact(
    discoverInformationAgentContacts(sale).filter(
      (candidate) => !checkAddresses || !informationAgentAddressHygieneIssue(candidate.email),
    ),
  );
}

/**
 * L'adresse figure dans `registry_contacts` de la vente. RÈGLE LIÉE : ces lignes sont lues avec le filtre
 * `observation_channel = INFORMATION_AGENT_PIPELINE_CHANNEL` (`admin-information-agent-sale.ts`) ; une adresse du
 * registre interne est donc une adresse Licitor décodée. Si ce filtre change, ce tri préalable change avec lui.
 */
function isLicitorRegistryAddress(sale: AdminInformationAgentSale, email: string): boolean {
  const wanted = normalizedEmail(email);
  return (sale.registry_contacts ?? []).some(
    (contact) => normalizedEmail(contact.email) === wanted,
  );
}

/**
 * La garde des envois aux notaires refusera ce candidat à l'aperçu : même prédicat que la garde
 * (`informationAgentNotarySendClosed`, config.ts), sur le destinataire et la vente tels que le brouillon les
 * enregistrera (`question_audience`, `sale_audience` : mêmes fonctions que `draft.ts`). Écarté d'avance, il ne
 * compte ni parmi les examens du passage ni en rejet de politique (arrêt automatique).
 */
function notarySendWillBeRefused(
  sale: AdminInformationAgentSale,
  selected: InformationAgentContactCandidate,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const { organizerType, sourceName } = resolveInformationAgentListingContacts(sale);
  return informationAgentNotarySendClosed(
    {
      role: selected.role,
      questionAudience: informationAgentQuestionAudience({
        role: selected.role,
        structureKind: selected.structureKind,
        organizerType,
        sourceName,
      }),
      saleAudience: informationAgentSaleAudience({ organizerType, sourceName }),
      email: selected.email,
    },
    env,
  );
}

/** Missions encore ouvertes sur une vente : brouillon, ou échec à reprendre. */
const OPEN_DRAFT_STATUSES = ["draft", "failed"];
/** Lignes lues au plus par la lecture groupée des brouillons d'une page de la file. */
const PAGE_DRAFTS_LIMIT = 500;

/** Mission ouverte par un administrateur, pas par le pilote : le pilote ne la touche jamais. */
function isHumanDraft(row: { metadata: Json }): boolean {
  const metadata = row.metadata;
  const trigger =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.trigger : null;
  return trigger !== "autopilot";
}

/** Brouillon d'un administrateur (ou échec à reprendre) sur cette vente : le pilote ne le touche jamais. */
async function humanDraftExists(saleId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("id,metadata")
    .eq("sale_id", saleId)
    .in("status", OPEN_DRAFT_STATUSES)
    .limit(20);
  if (error) throw error;
  return (data ?? []).some(isHumanDraft);
}

/**
 * Ventes d'une page de la file qui portent un brouillon d'administrateur, en UNE lecture : même définition que
 * `humanDraftExists`. Une vente coupée par la limite est simplement absente : l'examen la vérifie.
 */
async function loadHumanDraftSaleIds(saleIds: readonly string[]): Promise<Set<string>> {
  if (!saleIds.length) return new Set();
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("sale_id,metadata")
    .in("sale_id", [...saleIds])
    .in("status", OPEN_DRAFT_STATUSES)
    .limit(PAGE_DRAFTS_LIMIT);
  if (error) throw error;
  return new Set(
    (data ?? []).flatMap((row) => (row.sale_id && isHumanDraft(row) ? [row.sale_id] : [])),
  );
}

/**
 * Clés d'opposition du contact retenu, et identité de la personne seule : une clé de structure ne dit pas qui est le
 * professionnel (règle « identité complète »). Même calcul pour le tri de la file et pour l'examen.
 */
function contactKeys(
  sale: AdminInformationAgentSale,
  selected: InformationAgentContactCandidate,
  email: string,
) {
  const oppositionKeys = recipientOppositionKeys({
    role: selected.role,
    name: selected.name ?? sale.lawyer_name,
    place: saleIdentityPlace(sale),
    email,
    officeCode: selected.officeCode,
    addressKind: selected.addressKind,
  });
  return { oppositionKeys, identityKeys: personIdentityKeys(oppositionKeys.identityKeys) };
}

/** Faits de l'annonce lus par le tri de la file pour une vente retenue jusque-là. */
type QueueSurvivor = {
  saleId: string;
  email: string;
  identityKeys: string[];
  facts: Parameters<typeof autopilotQueueRefusal>[0];
};

/**
 * Tri préalable d'une page de la file, sans examen : le motif de refus de chaque vente (nul : à examiner). Deux
 * lectures légères (paquets de 50), puis, pour les ventes restantes, une lecture groupée des brouillons et une du
 * premier enregistrement des adresses (règle de l'article 14 active), et une des envois précédents pour les seules
 * adresses hors délai. Une étape du passage au sens de la borne de temps.
 */
async function queuePageRefusals(
  queued: readonly string[],
  settings: AutopilotSettings,
  now: Date,
  env: Readonly<Record<string, string | undefined>>,
  checkAddresses: boolean,
): Promise<Map<string, string | null>> {
  const refusals = new Map<string, string | null>();
  const survivors: QueueSurvivor[] = [];
  for (let start = 0; start < queued.length; start += CONTACT_SALES_CHUNK) {
    const chunk = queued.slice(start, start + CONTACT_SALES_CHUNK);
    const { sales } = await loadInformationAgentContactSales({
      auth: { isAdmin: true },
      saleIds: chunk,
    });
    for (const saleId of chunk) {
      const sale = sales.get(saleId);
      // Classe A vérifiée avec le résolveur du brouillon : un contact choisi seul dans l'annonce.
      const selected = sale ? listingSelection(sale, checkAddresses) : null;
      if (!sale || !selected) {
        refusals.set(saleId, "not_class_a");
        continue;
      }
      // Les clés de la personne ne dépendent pas de l'adresse (seules celles de la structure en dépendent).
      const { identityKeys } = contactKeys(sale, selected, selected.email);
      const facts = {
        recipientRole: selected.role,
        identityComplete: identityKeys.length > 0,
        consumerDomain: isConsumerMailAddress(selected.email),
        observationChannel: isLicitorRegistryAddress(sale, selected.email)
          ? INFORMATION_AGENT_PIPELINE_CHANNEL
          : null,
        saleDate: sale.sale_date ?? null,
      };
      const refusal =
        autopilotQueueRefusal(facts, settings, now) ??
        (notarySendWillBeRefused(sale, selected, env) ? "notary_send_closed" : null);
      refusals.set(saleId, refusal);
      const email = normalizedEmail(selected.email);
      // Adresse invalide : rien à lire pour elle, l'examen la refuse (`address_invalid`).
      if (!refusal && email) survivors.push({ saleId, email, identityKeys, facts });
    }
  }
  if (!survivors.length) return refusals;
  const [humanDrafts, firstRecorded] = await Promise.all([
    loadHumanDraftSaleIds(survivors.map((survivor) => survivor.saleId)),
    settings.art14RuleEnabled
      ? loadAutopilotFirstRecordedAt(survivors.map((survivor) => survivor.email))
      : new Map<string, string>(),
  ]);
  // Envois précédents lus pour les seules adresses que l'article 14 refuserait à une personne jamais informée.
  const late = survivors.filter((survivor) => {
    const contactFirstRecordedAt = firstRecorded.get(survivor.email) ?? null;
    return (
      contactFirstRecordedAt !== null &&
      autopilotArt14Refusal({ alreadyInformed: false, contactFirstRecordedAt }, settings, now) !==
        null
    );
  });
  const informed = late.length ? await loadAutopilotAlreadyInformed(late) : [];
  const alreadyInformed = new Map(
    informed ? late.map((survivor, index) => [survivor.saleId, informed[index]] as const) : [],
  );
  for (const survivor of survivors) {
    refusals.set(
      survivor.saleId,
      autopilotQueueRefusal(
        {
          ...survivor.facts,
          humanDraftExists: humanDrafts.has(survivor.saleId),
          contactFirstRecordedAt: firstRecorded.get(survivor.email) ?? null,
          alreadyInformed: alreadyInformed.get(survivor.saleId),
        },
        settings,
        now,
      ),
    );
  }
  return refusals;
}

export async function findAutopilotCandidates({
  settings,
  now,
  limit,
  maxExamined = 25,
  env = process.env,
  shouldStop = () => false,
}: {
  settings: AutopilotSettings;
  now: Date;
  /** Nombre de candidats recherchés. */
  limit: number;
  maxExamined?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Borne de temps du passage : vrai, plus aucune lecture de la file ni aucun examen n'est entamé. */
  shouldStop?: () => boolean;
}): Promise<AutopilotCandidateSearch> {
  const result: AutopilotCandidateSearch = { candidates: [], skipped: {}, examined: 0 };
  const skip = (code: string) => {
    result.skipped[code] = (result.skipped[code] ?? 0) + 1;
  };
  const done = () =>
    result.candidates.length >= limit || result.examined >= maxExamined || shouldStop();
  const checkAddresses = informationAgentAddressCheckEnabled(env);

  for (let offset = 0; offset < MAX_QUEUE_SCAN && !done(); offset += SALE_BATCH) {
    const queued = await readQueuePage(offset);
    const refusals = await queuePageRefusals(queued, settings, now, env, checkAddresses);
    for (const saleId of queued) {
      if (done()) break;
      const refusal = refusals.get(saleId);
      if (refusal) {
        skip(refusal);
        continue;
      }
      result.examined += 1;
      const examined = await examineAutopilotSale(saleId, settings, now, checkAddresses);
      if ("skip" in examined) skip(examined.skip);
      else result.candidates.push(examined);
    }
    if (queued.length < SALE_BATCH) break;
  }
  return result;
}

/** Examen complet d'une vente retenue par le tri préalable : lectures en base, puis `evaluateAutopilotCandidate`. */
async function examineAutopilotSale(
  saleId: string,
  settings: AutopilotSettings,
  now: Date,
  checkAddresses: boolean,
): Promise<AutopilotCandidate | { skip: string }> {
  const sale = await loadAdminInformationAgentSale({ auth: { isAdmin: true }, saleId });
  const selected = listingSelection(sale, checkAddresses);
  if (!selected) return { skip: "contact_ambiguous" };
  const email = normalizedEmail(selected.email);
  if (!email) return { skip: "address_invalid" };
  const { oppositionKeys, identityKeys } = contactKeys(sale, selected, email);
  // Opposition (adresse et identité) vérifiée dès la sélection.
  try {
    await assertInformationAgentContactAllowed({
      saleId,
      email,
      identityKeys: oppositionKeys.identityKeys,
      checkKeys: oppositionKeys.checkKeys,
    });
  } catch {
    return { skip: "opposed" };
  }
  // Relevé de l'adresse lue dans l'annonce : enregistré maintenant (comme à la création d'un brouillon), pour que
  // la date de relevé et celle du premier enregistrement (art. 14) viennent du contact, jamais de la vente.
  await persistInformationAgentContactObservations({ saleId, candidates: [selected] });
  const [registry, history, excluded, humanDraft, claimRead] = await Promise.all([
    loadAutopilotRegistryFacts(email, saleId),
    loadAutopilotHistoryFacts(email, identityKeys, now),
    loadExcludedIdentityKeys(identityKeys),
    humanDraftExists(saleId),
    readSaleFactClaims(saleId),
  ]);
  const facts = getFactReliabilitiesFromClaims(sale, claimRead.claims);
  const gaps = detectInformationGaps(sale, facts, buildInformationAgentInventory(sale, facts));
  const hygiene = checkAddresses ? informationAgentAddressHygieneIssue(email) : null;
  const mailDomain = checkAddresses ? await checkMailDomain(mailDomainOf(email)) : "ok";
  const verdict = evaluateAutopilotCandidate(
    {
      // Origine réelle de l'adresse : absente ou autre que l'annonce, refus (aucune valeur par défaut).
      sourceKind: candidateSourceKind(selected, registry.originKinds),
      recipientRole: selected.role,
      selectedUnambiguously: true,
      identityComplete: identityKeys.length > 0,
      addressHygieneIssue: hygiene,
      consumerDomain: isConsumerMailAddress(email),
      observationChannel: registry.licitorDecoded ? INFORMATION_AGENT_PIPELINE_CHANNEL : null,
      // Date de relevé du contact au registre : jamais un repli sur la date de la vente.
      addressObservedAt: registry.observedAt,
      mailDomain,
      saleDate: sale.sale_date ?? null,
      hasUnpublishedGap: gaps.length > 0,
      humanDraftExists: humanDraft,
      identityExcluded: [...excluded].length > 0,
      contactFirstRecordedAt: registry.firstRecordedAt,
      ...history,
    },
    settings,
    now,
  );
  if (!verdict.ok) return { skip: verdict.code };
  return {
    saleId,
    tribunalCode: sale.tribunal_code?.trim() || null,
    email,
    domain: mailDomainOf(email),
    officeCode: selected.officeCode ?? null,
    identityKeys,
  };
}

/**
 * Origine de l'adresse retenue : `sale_listing` seulement si toutes ses provenances sont l'annonce (champ, bloc ou
 * texte de la vente, ou ligne du registre `sale_listing`) et si aucune autre origine n'est enregistrée pour cette
 * adresse et cette vente. Sinon l'origine réelle ; aucune provenance : `null` (refus).
 */
export function candidateSourceKind(
  candidate: {
    source?: { kind: string };
    provenance: ReadonlyArray<{ kind: string }>;
  },
  registryKinds: readonly string[],
): string | null {
  if (registryKinds.some((kind) => kind !== "sale_listing")) {
    return registryKinds.find((kind) => kind !== "sale_listing") ?? null;
  }
  if (candidate.source && candidate.source.kind !== "sale_listing") return candidate.source.kind;
  const kinds = candidate.provenance.map((item) => item.kind);
  if (!kinds.length) return null;
  const listing = new Set(["sale_field", "source_block", "source_text"]);
  if (kinds.every((kind) => listing.has(kind) || candidate.source?.kind === "sale_listing")) {
    return "sale_listing";
  }
  return kinds.find((kind) => !listing.has(kind)) ?? null;
}
