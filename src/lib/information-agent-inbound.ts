import { createHash, randomUUID } from "node:crypto";
import { Resend, type AttachmentData, type EmailReceivedEvent } from "resend";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "text/plain",
]);

type SharedCase = Database["public"]["Tables"]["information_agent_cases"]["Row"];
type Mission = Database["public"]["Tables"]["information_agent_missions"]["Row"];

export type ExtractedInformationAgentFact = {
  factKey: "surface_m2" | "rooms_count" | "occupancy_status";
  proposedValue: { value: number | string; unit?: string };
  displayValue: string;
  evidenceExcerpt: string;
  confidence: number;
};

export type InformationAgentInboundResult = {
  accepted: boolean;
  ignored?: boolean;
  duplicate?: boolean;
  caseId?: string;
  messageId?: string;
  factCount?: number;
  attachmentCount?: number;
};

export async function processInformationAgentInboundWebhook({
  request,
  env = process.env,
  fetchImpl = fetch,
}: {
  request: Request;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<InformationAgentInboundResult> {
  const apiKey = env.RESEND_API_KEY?.trim();
  const webhookSecret = env.RESEND_WEBHOOK_SECRET?.trim();
  const inboundDomain = env.INFORMATION_AGENT_INBOUND_DOMAIN?.trim().toLowerCase();
  if (!apiKey || !webhookSecret || !inboundDomain) {
    throw new Error("Configuration de réception de l’agent incomplète.");
  }

  const rawPayload = await request.text();
  const resend = new Resend(apiKey);
  const event = resend.webhooks.verify({
    payload: rawPayload,
    headers: {
      id: requiredHeader(request, "svix-id"),
      timestamp: requiredHeader(request, "svix-timestamp"),
      signature: requiredHeader(request, "svix-signature"),
    },
    webhookSecret,
  });
  if (event.type !== "email.received") return { accepted: true, ignored: true };

  return ingestReceivedEmail({
    event,
    resend,
    inboundDomain,
    fetchImpl,
  });
}

async function ingestReceivedEmail({
  event,
  resend,
  inboundDomain,
  fetchImpl,
}: {
  event: EmailReceivedEvent;
  resend: Resend;
  inboundDomain: string;
  fetchImpl: typeof fetch;
}): Promise<InformationAgentInboundResult> {
  const token = findInboundToken([...event.data.to, ...event.data.received_for], inboundDomain);
  if (!token) return { accepted: true, ignored: true };

  const { data: sharedCase, error: caseError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("*")
    .eq("inbound_token", token)
    .maybeSingle();
  if (caseError) throw caseError;
  if (!sharedCase) return { accepted: true, ignored: true };

  const mission = await loadInitiatorMission(sharedCase);
  const { data: received, error: receiveError } = await resend.emails.receiving.get(
    event.data.email_id,
    { html_format: "cid" },
  );
  if (receiveError || !received) {
    throw new Error(receiveError?.message || "Email entrant Resend introuvable.");
  }

  const bodyText = cleanInboundBody(received.text, received.html);
  const receivedAt = received.created_at || event.created_at;
  const senderMatches = normalizeEmail(received.from) === sharedCase.normalized_recipient_email;
  const messageId = await insertOrLoadInboundMessage({
    sharedCase,
    mission,
    providerMessageId: event.data.email_id,
    from: received.from,
    to: received.to.join(", "),
    subject: received.subject || `Re: ${sharedCase.subject}`,
    bodyText,
    receivedAt,
    senderMatches,
  });

  const attachments = await fetchInboundAttachments(resend, event.data.email_id);
  const storedAssets = await storeInboundAttachments({
    attachments,
    sharedCase,
    messageId,
    fetchImpl,
  });
  const extractedFacts = extractInformationAgentFacts(bodyText);
  await persistFactCandidates({
    sharedCase,
    messageId,
    facts: extractedFacts,
    assets: storedAssets,
  });

  const now = new Date().toISOString();
  const { error: updateCaseError } = await supabaseAdmin
    .from("information_agent_cases")
    .update({
      status: extractedFacts.length || storedAssets.length ? "review" : "replied",
      replied_at: receivedAt,
      failure_reason: null,
      metadata: mergeJsonObject(sharedCase.metadata, {
        last_inbound_email_id: event.data.email_id,
        last_inbound_sender_matches_recipient: senderMatches,
      }),
    })
    .eq("id", sharedCase.id);
  if (updateCaseError) throw updateCaseError;

  const { error: updateMissionsError } = await supabaseAdmin
    .from("information_agent_missions")
    .update({ status: "replied", replied_at: receivedAt, updated_at: now })
    .eq("case_id", sharedCase.id)
    .in("status", ["sent", "subscribed", "replied"]);
  if (updateMissionsError) throw updateMissionsError;

  return {
    accepted: true,
    caseId: sharedCase.id,
    messageId,
    factCount: extractedFacts.length + storedAssets.length,
    attachmentCount: storedAssets.length,
  };
}

async function loadInitiatorMission(sharedCase: SharedCase): Promise<Mission> {
  let query = supabaseAdmin.from("information_agent_missions").select("*");
  query = sharedCase.initiator_mission_id
    ? query.eq("id", sharedCase.initiator_mission_id)
    : query.eq("case_id", sharedCase.id).order("created_at", { ascending: true }).limit(1);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Mission initiatrice du dossier introuvable.");
  return data;
}

async function insertOrLoadInboundMessage({
  sharedCase,
  mission,
  providerMessageId,
  from,
  to,
  subject,
  bodyText,
  receivedAt,
  senderMatches,
}: {
  sharedCase: SharedCase;
  mission: Mission;
  providerMessageId: string;
  from: string;
  to: string;
  subject: string;
  bodyText: string;
  receivedAt: string;
  senderMatches: boolean;
}): Promise<string> {
  const id = randomUUID();
  const { error } = await supabaseAdmin.from("information_agent_messages").insert({
    id,
    case_id: sharedCase.id,
    mission_id: mission.id,
    user_id: mission.user_id,
    direction: "inbound",
    message_kind: "reply",
    delivery_status: "received",
    from_email: from,
    to_email: to,
    subject: subject.slice(0, 200),
    body_text: bodyText,
    provider_message_id: providerMessageId,
    received_at: receivedAt,
    metadata: {
      imported_manually: false,
      content_trust: "untrusted",
      sender_matches_recipient: senderMatches,
    },
  });
  if (!error) return id;

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("id")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (existingError || !existing) throw error;
  return existing.id;
}

async function fetchInboundAttachments(resend: Resend, emailId: string) {
  const { data, error } = await resend.emails.receiving.attachments.list({ emailId });
  if (error) throw new Error(error.message || "Pièces jointes Resend indisponibles.");
  return data?.data ?? [];
}

async function storeInboundAttachments({
  attachments,
  sharedCase,
  messageId,
  fetchImpl,
}: {
  attachments: AttachmentData[];
  sharedCase: SharedCase;
  messageId: string;
  fetchImpl: typeof fetch;
}) {
  const stored: Array<{
    id: string;
    filename: string;
    mimeType: string;
    storagePath: string;
    size: number;
  }> = [];
  let totalBytes = 0;

  for (const attachment of attachments) {
    if (
      !ALLOWED_ATTACHMENT_MIME_TYPES.has(attachment.content_type) ||
      attachment.size <= 0 ||
      attachment.size > MAX_ATTACHMENT_BYTES ||
      totalBytes + attachment.size > MAX_TOTAL_ATTACHMENT_BYTES
    ) {
      continue;
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("id,original_filename,mime_type,storage_path,size_bytes")
      .eq("message_id", messageId)
      .eq("provider_attachment_id", attachment.id)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      stored.push({
        id: existing.id,
        filename: existing.original_filename,
        mimeType: existing.mime_type,
        storagePath: existing.storage_path,
        size: Number(existing.size_bytes),
      });
      totalBytes += Number(existing.size_bytes);
      continue;
    }

    const response = await fetchImpl(attachment.download_url, {
      headers: { accept: attachment.content_type },
    });
    if (!response.ok)
      throw new Error(`Téléchargement de pièce joint impossible (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) continue;

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filename = safeFilename(attachment.filename || `piece-${attachment.id}`);
    const storagePath = `${sharedCase.id}/${messageId}/${sha256}-${filename}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("information-agent-evidence")
      .upload(storagePath, bytes, {
        contentType: attachment.content_type,
        upsert: false,
      });
    if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;

    const { data: asset, error: assetError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .insert({
        case_id: sharedCase.id,
        message_id: messageId,
        sale_id: sharedCase.sale_id,
        provider_attachment_id: attachment.id,
        storage_path: storagePath,
        original_filename: filename,
        mime_type: attachment.content_type,
        size_bytes: bytes.length,
        sha256,
        metadata: { content_disposition: attachment.content_disposition },
      })
      .select("id")
      .single();
    if (assetError) throw assetError;
    stored.push({
      id: asset.id,
      filename,
      mimeType: attachment.content_type,
      storagePath,
      size: bytes.length,
    });
    totalBytes += bytes.length;
  }
  return stored;
}

async function persistFactCandidates({
  sharedCase,
  messageId,
  facts,
  assets,
}: {
  sharedCase: SharedCase;
  messageId: string;
  facts: ExtractedInformationAgentFact[];
  assets: Array<{
    id: string;
    filename: string;
    mimeType: string;
    storagePath: string;
    size: number;
  }>;
}) {
  const { data: sale, error: saleError } = await supabaseAdmin
    .from("auction_sales")
    .select("surface_m2,app_surface_m2,rooms_count,occupancy_status")
    .eq("id", sharedCase.sale_id)
    .single();
  if (saleError) throw saleError;

  const rows: Database["public"]["Tables"]["information_agent_fact_candidates"]["Insert"][] = [
    ...facts.map((fact) => ({
      case_id: sharedCase.id,
      message_id: messageId,
      sale_id: sharedCase.sale_id,
      fact_key: fact.factKey,
      proposed_value: fact.proposedValue,
      display_value: fact.displayValue,
      evidence_excerpt: fact.evidenceExcerpt,
      confidence: fact.confidence,
      status: conflictsWithSale(fact, sale) ? ("conflict" as const) : ("pending" as const),
    })),
    ...assets.map((asset) => ({
      case_id: sharedCase.id,
      message_id: messageId,
      sale_id: sharedCase.sale_id,
      evidence_asset_id: asset.id,
      fact_key: asset.mimeType.startsWith("image/") ? ("photo" as const) : ("document" as const),
      proposed_value: { value: asset.id, storage_path: asset.storagePath },
      display_value: asset.filename,
      evidence_excerpt: null,
      confidence: 1,
      status: "pending" as const,
    })),
  ];
  if (!rows.length) return;
  const { error } = await supabaseAdmin
    .from("information_agent_fact_candidates")
    .upsert(rows, { onConflict: "message_id,fact_key,display_value", ignoreDuplicates: true });
  if (error) throw error;
}

export function findInboundToken(
  addresses: readonly string[],
  inboundDomain: string,
): string | null {
  const escapedDomain = inboundDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|<)enquete\\+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})@${escapedDomain}(?:>|$)`,
    "i",
  );
  for (const address of addresses) {
    const match = address.trim().match(pattern);
    if (match?.[1]) return match[1].toLowerCase();
  }
  return null;
}

export function extractInformationAgentFacts(bodyText: string): ExtractedInformationAgentFact[] {
  const normalized = bodyText.replace(/\u00a0/g, " ");
  const facts: ExtractedInformationAgentFact[] = [];
  const surfaceMatch = normalized.match(
    /(?:surface(?:\s+(?:habitable|carrez|totale))?[^\d]{0,30})?(?<!\d)(\d{1,4}(?:[.,]\d{1,2})?)(?![\d.,])\s*m(?:²|2)(?![a-z0-9])/i,
  );
  if (surfaceMatch) {
    const value = Number(surfaceMatch[1].replace(",", "."));
    if (value > 0 && value <= 1000000) {
      facts.push({
        factKey: "surface_m2",
        proposedValue: { value, unit: "m2" },
        displayValue: `${value.toLocaleString("fr-FR")} m²`,
        evidenceExcerpt: excerptAround(normalized, surfaceMatch.index ?? 0),
        confidence: /surface/i.test(surfaceMatch[0]) ? 0.88 : 0.7,
      });
    }
  }

  const roomsMatch = normalized.match(/(?<!\d)(\d{1,2})(?!\d)\s+pi[eè]ces?\b/i);
  if (roomsMatch) {
    const value = Number(roomsMatch[1]);
    if (value >= 1 && value <= 100) {
      facts.push({
        factKey: "rooms_count",
        proposedValue: { value },
        displayValue: `${value} pièce${value > 1 ? "s" : ""}`,
        evidenceExcerpt: excerptAround(normalized, roomsMatch.index ?? 0),
        confidence: 0.86,
      });
    }
  }

  const occupancyPatterns: Array<[RegExp, string, string]> = [
    [/\b(?:bien|logement|maison|appartement)\s+(?:est\s+)?libre\b/i, "vacant", "Bien libre"],
    [/\b(?:bien|logement|maison|appartement)\s+(?:est\s+)?lou[ée]\b/i, "rented", "Bien loué"],
    [/\b(?:bien|logement|maison|appartement)\s+(?:est\s+)?occup[ée]\b/i, "occupied", "Bien occupé"],
    [/\bsquatt[ée]\b/i, "squatted", "Bien squatté"],
  ];
  for (const [pattern, value, label] of occupancyPatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    facts.push({
      factKey: "occupancy_status",
      proposedValue: { value },
      displayValue: label,
      evidenceExcerpt: excerptAround(normalized, match.index ?? 0),
      confidence: 0.82,
    });
    break;
  }
  return facts;
}

function conflictsWithSale(
  fact: ExtractedInformationAgentFact,
  sale: {
    surface_m2: number | null;
    app_surface_m2: number | null;
    rooms_count: number | null;
    occupancy_status: string | null;
  },
) {
  const value = fact.proposedValue.value;
  if (fact.factKey === "surface_m2") {
    const existing = sale.app_surface_m2 ?? sale.surface_m2;
    return existing != null && Math.abs(existing - Number(value)) > 0.5;
  }
  if (fact.factKey === "rooms_count") {
    return sale.rooms_count != null && sale.rooms_count !== Number(value);
  }
  return sale.occupancy_status != null && sale.occupancy_status !== value;
}

function cleanInboundBody(text: string | null, html: string | null) {
  const source =
    text?.trim() || stripHtml(html || "").trim() || "Réponse reçue sans corps de texte.";
  return source.slice(0, 16000);
}

function stripHtml(value: string) {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function safeFilename(value: string) {
  const safe = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || "piece-jointe";
}

function excerptAround(value: string, index: number) {
  return value.slice(Math.max(0, index - 80), Math.min(value.length, index + 240)).trim();
}

function normalizeEmail(value: string) {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase() ?? "";
}

function requiredHeader(request: Request, name: string) {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new Error(`Signature webhook incomplète: ${name}.`);
  return value;
}

function mergeJsonObject(current: Json, extra: Record<string, Json>): Json {
  const base = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  return { ...base, ...extra };
}
