import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import { PublicApiError } from "@/lib/api-errors";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import {
  informationAgentStructureKeys,
  isInformationAgentStructureKey,
} from "@/lib/information-agent/contact-structure";
import type {
  InformationAgentContactCandidate,
  InformationAgentContactSource,
} from "@/lib/information-agent/contact-resolution";
import { normalizedEmail } from "@/lib/information-agent/email-address";
import {
  INFORMATION_AGENT_EXCLUDED_ADDRESS_MESSAGE,
  informationAgentExcludedAddressReason,
} from "@/lib/information-agent/excluded-addresses";

/** Refus d'une valeur qui n'est pas une adresse email, quel que soit le contrôle de l'agent qui la reçoit. */
export class InformationAgentInvalidContactEmailError extends PublicApiError {
  constructor() {
    super("Adresse email du contact invalide.", 400);
    this.name = "InformationAgentInvalidContactEmailError";
  }
}

/** Adresse normalisée d'un contact ; refus (400) si la valeur n'est pas une adresse email. */
export function requireInformationAgentContactEmail(email: string): string {
  const normalized = normalizedEmail(email);
  if (!normalized) throw new InformationAgentInvalidContactEmailError();
  return normalized;
}

type InformationAgentContactRegistryRow =
  Database["public"]["Tables"]["information_agent_contacts"]["Row"];

export type InformationAgentContactRegistryBlock = Pick<
  InformationAgentContactRegistryRow,
  "scope_sale_id" | "opposition_status" | "bounce_status"
>;

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
  const normalized = requireInformationAgentContactEmail(email);

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
    if (!data) throw new Error("Contact registry read returned no data");
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
 * L'opposition de cette adresse vaudra-t-elle pour toute sa structure ? Oui quand l'adresse porte une clé de
 * structure, au registre ou dans une demande : c'est ce que le déclencheur de la base versera dans la liste
 * d'opposition. LECTURE SEULE, pour le dire à la personne sur la page d'opposition ; une erreur est propagée.
 */
export async function informationAgentOppositionCoversStructure(email: string): Promise<boolean> {
  const normalized = requireInformationAgentContactEmail(email);
  const [contacts, missions] = await Promise.all([
    supabaseAdmin
      .from("information_agent_contacts")
      .select("identity_keys")
      .eq("normalized_email", normalized)
      .limit(200),
    supabaseAdmin
      .from("information_agent_missions")
      .select("recipient_identity_keys")
      .ilike(
        "recipient_email",
        normalized.replace(/[\\%_]/g, (char) => `\\${char}`),
      )
      .limit(200),
  ]);
  if (contacts.error) throw contacts.error;
  if (missions.error) throw missions.error;
  return [
    ...(contacts.data ?? []).flatMap((row) => row.identity_keys ?? []),
    ...(missions.data ?? []).flatMap((row) => row.recipient_identity_keys ?? []),
  ].some(isInformationAgentStructureKey);
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
  checkKeys = [],
  courtRegistryAddress = false,
}: {
  email: string;
  saleId?: string | null;
  /** Clés d'identité du professionnel : une opposition vaut sous toute autre adresse. */
  identityKeys?: readonly string[];
  /**
   * Clés à contrôler en plus (`recipientOppositionKeys().checkKeys`) : la structure du destinataire et ses
   * domaines parents. Une opposition enregistrée pour la structure vaut pour toutes ses adresses.
   */
  checkKeys?: readonly string[];
  /**
   * L'adresse est celle du greffe du référentiel des tribunaux, vérifiée par l'appelant
   * (`assertCourtRegistryFallbackAddress`) : seule l'exclusion `court` est levée, pour cette adresse.
   * RPVA, Ordre, CARPA, adresses techniques, opposition et rebond restent contrôlés.
   */
  courtRegistryAddress?: boolean;
}): Promise<void> {
  const excludedReason = informationAgentExcludedAddressReason(email);
  if (excludedReason !== null && !(courtRegistryAddress && excludedReason === "court")) {
    throw new PublicApiError(INFORMATION_AGENT_EXCLUDED_ADDRESS_MESSAGE, 400);
  }
  const rows = await loadInformationAgentContactRegistry(email, saleId);
  if (rows.some((row) => isInformationAgentContactBlocked(row, saleId))) {
    throw new PublicApiError(
      "Le contact est explicitement opposé ou en rebond permanent ; aucune sollicitation n'est autorisée.",
      409,
    );
  }
  const opposed = await loadOpposedInformationAgentIdentityKeys([...identityKeys, ...checkKeys]);
  if (opposed.some(isInformationAgentStructureKey)) {
    throw new PublicApiError(INFORMATION_AGENT_STRUCTURE_OPPOSED_MESSAGE, 409);
  }
  if (opposed.length) throw new PublicApiError(INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE, 409);
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
 * Réservée à un administrateur.
 */
export async function recordInformationAgentStructureOpposition({
  auth,
  email,
  officeCode,
  opposedAt = new Date().toISOString(),
}: {
  auth: SupabaseAuthContext;
  email: string;
  officeCode?: string | null;
  opposedAt?: string;
}): Promise<string[]> {
  assertAdmin(auth);
  const normalized = requireInformationAgentContactEmail(email);
  const keys = informationAgentStructureKeys({ email: normalized, officeCode });
  if (!keys.length) throw new PublicApiError(INFORMATION_AGENT_STRUCTURE_UNKNOWN_MESSAGE, 400);
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
  if (!data) throw new Error("Identity opposition read returned no data");
  return data.map((row) => row.identity_key);
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
  const normalized = requireInformationAgentContactEmail(email);
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
