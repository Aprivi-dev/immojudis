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
  evaluateAutopilotCandidate,
  type AutopilotCandidateFacts,
  type AutopilotSettings,
} from "@/lib/information-agent/autopilot-rules";
import { loadExcludedIdentityKeys } from "@/lib/information-agent/autopilot-settings";
import {
  assertInformationAgentContactAllowed,
  discoverInformationAgentContacts,
  INFORMATION_AGENT_PIPELINE_CHANNEL,
  normalizedEmail,
  selectInformationAgentContact,
} from "@/lib/information-agent/contacts";
import { informationAgentIdentityKeys } from "@/lib/information-agent/identity";
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
  identityKeys: string[];
};

export type AutopilotCandidateSearch = {
  candidates: AutopilotCandidate[];
  /** Nombre de ventes écartées, par code de motif. */
  skipped: Record<string, number>;
  examined: number;
};

const DAY_MS = 86_400_000;
const SALE_BATCH = 100;

type RegistryRow = { created_at: string; scope_sale_id: string | null };

async function loadRegistryFacts(email: string): Promise<{ firstRecordedAt: string | null }> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_contacts")
    .select("created_at,scope_sale_id")
    .eq("normalized_email", email)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as RegistryRow | undefined;
  return { firstRecordedAt: row?.created_at ?? null };
}

/** Envois et réponses précédents à cette adresse ou à cette identité (dossiers et missions). */
async function loadHistoryFacts(
  email: string,
  identityKeys: readonly string[],
  now: Date,
): Promise<
  Pick<
    AutopilotCandidateFacts,
    "alreadyInformed" | "lastReplyAt" | "silentSendsInSixMonths" | "lastSendAt"
  >
> {
  const [cases, missions] = await Promise.all([
    supabaseAdmin
      .from("information_agent_cases")
      .select("sent_at,replied_at")
      .eq("normalized_recipient_email", email)
      .not("sent_at", "is", null)
      .limit(50),
    identityKeys.length
      ? supabaseAdmin
          .from("information_agent_missions")
          .select("sent_at,replied_at")
          .overlaps("recipient_identity_keys", [...identityKeys])
          .not("sent_at", "is", null)
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (cases.error) throw cases.error;
  if (missions.error) throw missions.error;
  const rows = [...(cases.data ?? []), ...(missions.data ?? [])];
  const sixMonthsAgo = now.getTime() - 183 * DAY_MS;
  const sentAt = rows.map((row) => Date.parse(row.sent_at ?? "")).filter(Number.isFinite);
  const replies = rows.map((row) => Date.parse(row.replied_at ?? "")).filter(Number.isFinite);
  const iso = (time: number) => new Date(time).toISOString();
  return {
    alreadyInformed: rows.length > 0,
    lastReplyAt: replies.length ? iso(Math.max(...replies)) : null,
    silentSendsInSixMonths: rows.filter(
      (row) => !row.replied_at && Date.parse(row.sent_at ?? "") >= sixMonthsAgo,
    ).length,
    lastSendAt: sentAt.length ? iso(Math.max(...sentAt)) : null,
  };
}

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
    const identityKeys = informationAgentIdentityKeys({
      role: selected.role,
      name: selected.name ?? sale.lawyer_name,
      ...saleIdentityPlace(sale),
    });
    // Opposition (adresse et identité) vérifiée dès la sélection.
    try {
      await assertInformationAgentContactAllowed({ saleId, email, identityKeys });
    } catch {
      skip("opposed");
      continue;
    }
    const [registry, history, excluded, humanDraft, claimRead] = await Promise.all([
      loadRegistryFacts(email),
      loadHistoryFacts(email, identityKeys, now),
      loadExcludedIdentityKeys(identityKeys),
      humanDraftExists(saleId),
      readSaleFactClaims(saleId),
    ]);
    const facts = getFactReliabilitiesFromClaims(sale, claimRead.claims);
    const gaps = detectInformationGaps(sale, facts, buildInformationAgentInventory(sale, facts));
    const hygiene = checkAddresses ? informationAgentAddressHygieneIssue(email) : null;
    const mailDomain = checkAddresses ? await checkMailDomain(mailDomainOf(email)) : "ok";
    const fromRegistry = (sale.registry_contacts ?? []).some(
      (contact) => normalizedEmail(contact.email) === email,
    );
    const verdict = evaluateAutopilotCandidate(
      {
        // Toute adresse découverte vient de l'annonce de la vente ; une autre origine est refusée par la règle.
        sourceKind: selected.source?.kind ?? "sale_listing",
        recipientRole: selected.role,
        selectedUnambiguously: true,
        identityComplete: identityKeys.length > 0,
        addressHygieneIssue: hygiene,
        consumerDomain: isConsumerMailAddress(email),
        observationChannel: fromRegistry ? INFORMATION_AGENT_PIPELINE_CHANNEL : null,
        // Adresse lue dans l'annonce : relevée avec la dernière actualisation de la vente.
        addressObservedAt:
          selected.source?.observedAt ??
          (typeof sale.updated_at === "string" ? sale.updated_at : null),
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
      identityKeys,
    });
  }
  return result;
}
