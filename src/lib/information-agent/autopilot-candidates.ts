import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  classifyInformationAgentSaleContacts,
  loadAdminInformationAgentSale,
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
  loadAutopilotHistoryFacts,
  loadAutopilotRegistryFacts,
} from "@/lib/information-agent/autopilot-facts";
import {
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
  selectInformationAgentContact,
} from "@/lib/information-agent/contact-resolution";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import {
  personIdentityKeys,
  recipientOppositionKeys,
} from "@/lib/information-agent/opposition-keys";
import { saleIdentityPlace } from "@/lib/information-agent/mission-identity";

/**
 * Candidats du pilote automatique. Point de départ : la file de l'agent (RPC `admin_information_agent_queue`,
 * classe A, vérifiée par le résolveur exact), puis une vérification candidat par candidat :
 * `evaluateAutopilotCandidate` (règles pures) sur des faits lus ici. Jamais de recherche réseau d'adresse,
 * jamais de greffe : seulement l'avocat dont l'adresse figure dans l'annonce de la vente.
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

/** Brouillon d'un administrateur (ou échec à reprendre) sur cette vente : le pilote ne le touche jamais. */
async function humanDraftExists(saleId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_missions")
    .select("id,metadata")
    .eq("sale_id", saleId)
    .in("status", ["draft", "failed"])
    .limit(20);
  if (error) throw error;
  return (data ?? []).some((row) => {
    const metadata = row.metadata;
    const trigger =
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata.trigger
        : null;
    return trigger !== "autopilot";
  });
}

export async function findAutopilotCandidates({
  settings,
  now,
  limit,
  maxExamined = 25,
  env = process.env,
}: {
  settings: AutopilotSettings;
  now: Date;
  /** Nombre de candidats recherchés. */
  limit: number;
  maxExamined?: number;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<AutopilotCandidateSearch> {
  const result: AutopilotCandidateSearch = { candidates: [], skipped: {}, examined: 0 };
  const skip = (code: string) => {
    result.skipped[code] = (result.skipped[code] ?? 0) + 1;
  };
  const { data, error } = await supabaseAdmin.rpc("admin_information_agent_queue", {
    p_limit: SALE_BATCH,
    p_offset: 0,
    p_class: "A",
  });
  if (error) throw error;
  const queued = ((data as { items?: Array<{ id: string }> } | null)?.items ?? []).map(
    (item) => item.id,
  );
  // Vérification exacte avec le résolveur du brouillon : seule la classe A reste.
  const classes = await classifyInformationAgentSaleContacts(queued);
  const checkAddresses = informationAgentAddressCheckEnabled(env);

  for (const saleId of queued) {
    if (result.candidates.length >= limit || result.examined >= maxExamined) break;
    if (classes.get(saleId) !== "A") {
      skip("not_class_a");
      continue;
    }
    result.examined += 1;
    const sale = await loadAdminInformationAgentSale({ auth: { isAdmin: true }, saleId });
    const listed = discoverInformationAgentContacts(sale).filter(
      (candidate) => !checkAddresses || !informationAgentAddressHygieneIssue(candidate.email),
    );
    const selected = selectInformationAgentContact(listed);
    if (!selected) {
      skip("contact_ambiguous");
      continue;
    }
    const email = normalizedEmail(selected.email);
    if (!email) {
      skip("address_invalid");
      continue;
    }
    const oppositionKeys = recipientOppositionKeys({
      role: selected.role,
      name: selected.name ?? sale.lawyer_name,
      place: saleIdentityPlace(sale),
      email,
      officeCode: selected.officeCode,
      addressKind: selected.addressKind,
    });
    // Identité du professionnel seule : une clé de structure ne dit pas qui il est (règle « identité complète »).
    const identityKeys = personIdentityKeys(oppositionKeys.identityKeys);
    // Opposition (adresse et identité) vérifiée dès la sélection.
    try {
      await assertInformationAgentContactAllowed({
        saleId,
        email,
        identityKeys: oppositionKeys.identityKeys,
        checkKeys: oppositionKeys.checkKeys,
      });
    } catch {
      skip("opposed");
      continue;
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
    if (!verdict.ok) {
      skip(verdict.code);
      continue;
    }
    result.candidates.push({
      saleId,
      tribunalCode: sale.tribunal_code?.trim() || null,
      email,
      domain: mailDomainOf(email),
      officeCode: selected.officeCode ?? null,
      identityKeys,
    });
  }
  return result;
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
