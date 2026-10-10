import "server-only";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import type { AuctionSale } from "@/lib/types";

export type InformationAgentRecipientKind =
  | "source_lawyer"
  | "source_contact"
  | "manual_professional";

export type InformationAgentContactRole = "lawyer" | "notary" | "organizer" | "source_contact";

export type InformationAgentContactProvenance = {
  kind: "sale_field" | "source_block" | "source_text";
  field: string;
  sourceName: string | null;
  sourceUrl: string | null;
};

export type InformationAgentContactCandidate = {
  email: string;
  name: string | null;
  role: InformationAgentContactRole;
  recipientKind: Extract<InformationAgentRecipientKind, "source_lawyer" | "source_contact">;
  confidence: "high" | "medium" | "low";
  score: number;
  provenance: InformationAgentContactProvenance[];
};

type InformationAgentContactRegistryRow =
  Database["public"]["Tables"]["information_agent_contacts"]["Row"];

export type InformationAgentContactRegistryBlock = Pick<
  InformationAgentContactRegistryRow,
  "scope_sale_id" | "opposition_status" | "bounce_status"
>;

/**
 * Finds contacts already present in the collected listing payload.
 *
 * This is deliberately source-data-only: it never performs a network lookup
 * and it keeps enough provenance for an admin to understand why a contact was
 * suggested before approving a request.
 */
export function discoverInformationAgentContacts(
  sale: AuctionSale,
): InformationAgentContactCandidate[] {
  const sourceName = cleanContactValue(sale.source_name ?? sale.primary_source);
  const sourceUrl = firstSourceUrl(sale);
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

  const byEmail = new Map<string, InformationAgentContactCandidate>();
  for (const observation of observations) {
    for (const email of extractEmails(observation.value)) {
      const role = inferContactRole(`${observation.field} ${observation.value}`);
      const score = observation.score + (role === "source_contact" ? 0 : 4);
      const provenance: InformationAgentContactProvenance = {
        kind: observation.kind,
        field: observation.field,
        sourceName: observation.sourceName,
        sourceUrl: observation.sourceUrl,
      };
      const current = byEmail.get(email);
      if (!current) {
        byEmail.set(email, {
          email,
          name: observation.name ?? null,
          role,
          recipientKind: role === "lawyer" ? "source_lawyer" : "source_contact",
          confidence: confidenceForContactScore(score),
          score,
          provenance: [provenance],
        });
        continue;
      }
      if (!current.provenance.some((item) => sameContactProvenance(item, provenance))) {
        current.provenance.push(provenance);
      }
      if (score > current.score) {
        current.score = score;
        current.confidence = confidenceForContactScore(score);
        current.role = role;
        current.recipientKind = role === "lawyer" ? "source_lawyer" : "source_contact";
      }
      if (!current.name && observation.name) current.name = observation.name;
    }
  }

  return [...byEmail.values()].sort(
    (left, right) => right.score - left.score || left.email.localeCompare(right.email),
  );
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
  const rows = [...byEmail.values()].map((candidate) => ({
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
    source_url: candidate.provenance.find((item) => item.sourceUrl)?.sourceUrl ?? null,
    metadata: {
      observation_channel: "information_agent_draft",
      confidence: candidate.confidence,
      score: candidate.score,
    },
    last_seen_at: observedAt,
  }));
  if (!rows.length) return;
  const { error } = await supabaseAdmin.from("information_agent_contacts").upsert(rows, {
    onConflict: "scope_sale_id,normalized_email",
    ignoreDuplicates: true,
  });
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
}: {
  email: string;
  saleId?: string | null;
}): Promise<void> {
  const rows = await loadInformationAgentContactRegistry(email, saleId);
  if (rows.some((row) => isInformationAgentContactBlocked(row, saleId))) {
    throw new Error(
      "Le contact est explicitement opposé ou en rebond permanent ; aucune sollicitation n'est autorisée.",
    );
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
    const childSourceName = rootField === "source_blocks_by_source" ? key : sourceName;
    if (typeof child === "string") {
      addContactObservation(observations, {
        value: child,
        kind: "source_block",
        field,
        sourceName: childSourceName,
        sourceUrl,
        name: inferNameFromSourceBlock(child, field),
        score: contactScoreForField(field),
      });
      continue;
    }
    collectSourceBlockContacts(observations, child, field, childSourceName, sourceUrl);
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
      (value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])
        .map(normalizedEmail)
        .filter((email): email is string => Boolean(email)),
    ),
  ];
}

function inferContactRole(value: string): InformationAgentContactRole {
  const normalized = stripDiacritics(value).toLowerCase();
  if (/avocat|lawyer|cabinet/.test(normalized)) return "lawyer";
  if (/notair|notary|etude/.test(normalized)) return "notary";
  if (/organisat|organizer|commissaire|vendeur/.test(normalized)) return "organizer";
  return "source_contact";
}

function inferNameFromSourceBlock(value: string, field: string): string | null {
  if (!/(?:nom|name|avocat|notaire|notary|organisateur|organizer)/i.test(field)) return null;
  const withoutEmail = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, " ");
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
    provenance: candidate.provenance.map((item) => ({
      kind: item.kind,
      field: item.field,
      source_name: item.sourceName,
      source_url: item.sourceUrl,
    })),
  };
}

export function informationAgentSourceText(sale: AuctionSale): string {
  const values = [sale.title, sale.source_description, sale.description];
  values.push(JSON.stringify(sale.source_blocks ?? {}));
  values.push(JSON.stringify(sale.source_blocks_by_source ?? {}));
  return values.filter((value): value is string => typeof value === "string").join("\n");
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

export function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return z.string().email().safeParse(normalized).success ? normalized : null;
}

function cleanContactValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
