import "server-only";
import { createHash } from "node:crypto";
import { Resend, type AttachmentData } from "resend";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { z } from "zod";
import { optionalText, type SharedCase } from "@/lib/information-agent-inbound/types";
import { replyTextForExtraction, safeFilename } from "@/lib/information-agent-inbound/text";
import {
  ensureInboundJobLease,
  type InboundJobLeaseGuard,
} from "@/lib/information-agent-inbound/lease";
import {
  conflictsWithSale,
  type ExtractedInformationAgentFact,
} from "@/lib/information-agent-inbound/fact-extraction";

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MAX_LISTED_ATTACHMENTS = 500;
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "text/plain",
]);
const ATTACHMENT_MIME_ALIASES: Record<string, string> = {
  "application/acrobat": "application/pdf",
  "application/octet-stream": "",
  "application/pdf": "application/pdf",
  "application/x-pdf": "application/pdf",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "text/csv": "text/plain",
  "text/markdown": "text/plain",
};
const ATTACHMENT_EXTENSION_MIME_TYPES: Record<string, string> = {
  ".csv": "text/plain",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".md": "text/plain",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".txt": "text/plain",
  ".webp": "image/webp",
};

const inboundAttachmentSchema = z.object({
  id: optionalText,
  filename: optionalText,
  content_type: optionalText,
  size: z
    .unknown()
    .transform((value) =>
      typeof value === "number" && Number.isSafeInteger(value) ? value : null,
    ),
  download_url: optionalText,
  content_disposition: optionalText,
  content_id: optionalText,
});
type InboundAttachmentFields = z.infer<typeof inboundAttachmentSchema>;

function parseInboundAttachment(attachment: unknown): InboundAttachmentFields {
  const parsed = inboundAttachmentSchema.safeParse(attachment);
  return parsed.success
    ? parsed.data
    : {
        id: null,
        filename: null,
        content_type: null,
        size: null,
        download_url: null,
        content_disposition: null,
        content_id: null,
      };
}

export type StoredInboundEvidenceAsset = {
  id: string;
  filename: string;
  mimeType: string;
  storagePath: string;
  size: number;
};

export async function fetchInboundAttachments(resend: Resend, emailId: string) {
  const attachments: AttachmentData[] = [];
  let after: string | undefined;
  while (attachments.length < MAX_LISTED_ATTACHMENTS) {
    const { data, error } = await resend.emails.receiving.attachments.list({
      emailId,
      limit: 100,
      after,
    });
    if (error) throw new Error(error.message || "Pièces jointes Resend indisponibles.");
    const page = data?.data ?? [];
    attachments.push(...page);
    if (!data?.has_more) return { attachments, truncated: false };
    const next = page.at(-1)?.id;
    if (!next || next === after) throw new Error("Pagination des pièces jointes Resend invalide.");
    after = next;
  }
  return { attachments: attachments.slice(0, MAX_LISTED_ATTACHMENTS), truncated: true };
}

export async function readBoundedAttachment(
  response: Response,
  limit: number,
): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function persistInboundBodyEvidence({
  bodyText,
  sharedCase,
  messageId,
  providerEmailId,
  assertJobLease,
  leaseId,
}: {
  bodyText: string;
  sharedCase: SharedCase;
  messageId: string;
  providerEmailId: string;
  assertJobLease?: InboundJobLeaseGuard;
  leaseId?: string;
}): Promise<StoredInboundEvidenceAsset | null> {
  const bodyForEvidence = replyTextForExtraction(bodyText).trim();
  if (!bodyForEvidence || bodyForEvidence === "Réponse reçue sans corps de texte.") return null;
  await ensureInboundJobLease(assertJobLease);

  const bytes = new TextEncoder().encode(bodyForEvidence);
  if (!bytes.length || bytes.length > MAX_TOTAL_ATTACHMENT_BYTES) return null;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const providerAttachmentId = `email-body:${messageId}`;
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("information_agent_evidence_assets")
    .select("id,original_filename,mime_type,storage_path,size_bytes,sha256")
    .eq("message_id", messageId)
    .eq("provider_attachment_id", providerAttachmentId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    if (existing.sha256 !== sha256) {
      throw new Error("Asset du corps entrant déjà enregistré avec un contenu différent.");
    }
    return {
      id: existing.id,
      filename: existing.original_filename,
      mimeType: existing.mime_type,
      storagePath: existing.storage_path,
      size: Number(existing.size_bytes),
    };
  }

  const storagePath = `${sharedCase.id}/${messageId}/body/${sha256}-email-body.txt`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from("information-agent-evidence")
    .upload(storagePath, bytes, {
      contentType: "text/plain",
      upsert: false,
    });
  if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;

  await ensureInboundJobLease(assertJobLease);
  const { data: asset, error: assetError } = await supabaseAdmin
    .from("information_agent_evidence_assets")
    .insert({
      case_id: sharedCase.id,
      message_id: messageId,
      sale_id: sharedCase.sale_id,
      provider_attachment_id: providerAttachmentId,
      storage_bucket: "information-agent-evidence",
      storage_path: storagePath,
      original_filename: "email-body.txt",
      mime_type: "text/plain",
      size_bytes: bytes.length,
      sha256,
      metadata: {
        evidence_kind: "email_body",
        content_trust: "untrusted_external_evidence",
        prompt_instructions_ignored: true,
        provider_email_id: providerEmailId,
        ...(leaseId ? { inbound_lease_id: leaseId, inbound_message_id: messageId } : {}),
      },
    })
    .select("id,original_filename,mime_type,storage_path,size_bytes")
    .single();
  if (assetError) {
    const { data: concurrentAsset, error: concurrentError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("id,original_filename,mime_type,storage_path,size_bytes,sha256")
      .eq("message_id", messageId)
      .eq("provider_attachment_id", providerAttachmentId)
      .maybeSingle();
    if (concurrentError || !concurrentAsset) {
      throw assetError;
    }
    if (concurrentAsset.sha256 !== sha256) {
      throw new Error("Asset concurrent du corps entrant avec un contenu différent.");
    }
    return {
      id: concurrentAsset.id,
      filename: concurrentAsset.original_filename,
      mimeType: concurrentAsset.mime_type,
      storagePath: concurrentAsset.storage_path,
      size: Number(concurrentAsset.size_bytes),
    };
  }
  return {
    id: asset.id,
    filename: asset.original_filename,
    mimeType: asset.mime_type,
    storagePath: asset.storage_path,
    size: Number(asset.size_bytes),
  };
}

export async function storeInboundAttachments({
  attachments,
  sharedCase,
  messageId,
  fetchImpl,
  assertJobLease,
  leaseId,
}: {
  attachments: AttachmentData[];
  sharedCase: SharedCase;
  messageId: string;
  fetchImpl: typeof fetch;
  assertJobLease?: InboundJobLeaseGuard;
  leaseId?: string;
}) {
  const stored: StoredInboundEvidenceAsset[] = [];
  const rejected: Array<{ filename: string; reason: string }> = [];
  let totalBytes = 0;

  for (const attachment of attachments) {
    await ensureInboundJobLease(assertJobLease);
    const fields = parseInboundAttachment(attachment);
    const attachmentId = fields.id;
    const rawFilename = fields.filename;
    const filename = safeFilename(rawFilename || `piece-${attachmentId || "jointe"}`);
    const rawMimeType = normalizeRawMimeType(fields.content_type);
    const mimeType = normalizeAttachmentMimeType(rawMimeType, filename);
    const declaredSize = fields.size;
    const downloadUrl = normalizeAttachmentDownloadUrl(fields.download_url);
    if (
      !attachmentId ||
      !ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType) ||
      declaredSize === null ||
      declaredSize <= 0 ||
      declaredSize > MAX_ATTACHMENT_BYTES ||
      totalBytes + declaredSize > MAX_TOTAL_ATTACHMENT_BYTES ||
      !downloadUrl
    ) {
      rejected.push({
        filename,
        reason: rawMimeType.startsWith("video/")
          ? "Vidéo non traitée : demander un autre mode de transmission"
          : !downloadUrl
            ? "Lien de téléchargement absent ou non sécurisé"
            : !ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)
              ? "Format non pris en charge"
              : "Taille hors limite",
      });
      continue;
    }

    const { data: existing, error: existingError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .select("id,original_filename,mime_type,storage_path,size_bytes")
      .eq("message_id", messageId)
      .eq("provider_attachment_id", attachmentId)
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

    let response: Response;
    try {
      response = await fetchImpl(downloadUrl, {
        headers: { accept: mimeType },
        redirect: "error",
      });
    } catch {
      // A Resend attachment URL is short-lived. Let the signed webhook be
      // retried for transient transport failures so a fresh URL can be
      // obtained from the provider before falling back to manual review.
      throw new Error("Téléchargement temporairement indisponible ; nouvelle tentative requise.");
    }
    if (!response.ok) {
      if ([408, 425, 429].includes(response.status) || response.status >= 500) {
        throw new Error(
          `Téléchargement temporairement indisponible (HTTP ${response.status}) ; nouvelle tentative requise.`,
        );
      }
      rejected.push({
        filename,
        reason: `Téléchargement impossible (HTTP ${response.status}) ; contrôle manuel requis`,
      });
      continue;
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await readBoundedAttachment(
        response,
        Math.min(MAX_ATTACHMENT_BYTES, MAX_TOTAL_ATTACHMENT_BYTES - totalBytes),
      );
    } catch {
      rejected.push({ filename, reason: "Lecture du fichier impossible ; contrôle manuel requis" });
      continue;
    }
    if (!bytes) {
      rejected.push({ filename, reason: "Taille réelle hors limite ou fichier vide" });
      continue;
    }

    await ensureInboundJobLease(assertJobLease);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const attachmentKey = createHash("sha256").update(attachmentId).digest("hex");
    const storagePath = `${sharedCase.id}/${messageId}/${attachmentKey}/${sha256}-${filename}`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("information-agent-evidence")
      .upload(storagePath, bytes, {
        contentType: mimeType,
        upsert: false,
      });
    if (uploadError && !/already exists|duplicate/i.test(uploadError.message)) throw uploadError;

    await ensureInboundJobLease(assertJobLease);
    const { data: asset, error: assetError } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .insert({
        case_id: sharedCase.id,
        message_id: messageId,
        sale_id: sharedCase.sale_id,
        provider_attachment_id: attachmentId,
        storage_path: storagePath,
        original_filename: filename,
        mime_type: mimeType,
        size_bytes: bytes.length,
        sha256,
        metadata: {
          ...(fields.content_disposition
            ? { content_disposition: fields.content_disposition }
            : {}),
          ...(fields.content_id ? { content_id: fields.content_id } : {}),
          ...(rawMimeType ? { declared_content_type: rawMimeType } : {}),
          declared_size: declaredSize,
          ...(leaseId ? { inbound_lease_id: leaseId, inbound_message_id: messageId } : {}),
        },
      })
      .select("id")
      .single();
    if (assetError) {
      // A concurrent replay can win the same insert after this request's lookup.
      // Only reuse a row tied to the exact provider attachment and content.
      const { data: concurrentAsset, error: concurrentError } = await supabaseAdmin
        .from("information_agent_evidence_assets")
        .select("id,original_filename,mime_type,storage_path,size_bytes,sha256")
        .eq("message_id", messageId)
        .eq("provider_attachment_id", attachmentId)
        .maybeSingle();
      if (concurrentError || !concurrentAsset || concurrentAsset.sha256 !== sha256) {
        throw assetError;
      }
      stored.push({
        id: concurrentAsset.id,
        filename: concurrentAsset.original_filename,
        mimeType: concurrentAsset.mime_type,
        storagePath: concurrentAsset.storage_path,
        size: Number(concurrentAsset.size_bytes),
      });
      totalBytes += Number(concurrentAsset.size_bytes);
      continue;
    }
    stored.push({
      id: asset.id,
      filename,
      mimeType,
      storagePath,
      size: bytes.length,
    });
    totalBytes += bytes.length;
  }
  return { stored, rejected };
}

export async function persistFactCandidates({
  sharedCase,
  messageId,
  facts,
  assets,
  assertJobLease,
  leaseId,
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
  assertJobLease?: InboundJobLeaseGuard;
  leaseId?: string;
}) {
  await ensureInboundJobLease(assertJobLease);
  const { data: sale, error: saleError } = await supabaseAdmin
    .from("auction_sales")
    .select(
      "surface_m2,app_surface_m2,land_surface_m2,rooms_count,occupancy_status,sale_date,starting_price_eur,property_type,address",
    )
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
      ...(leaseId
        ? { metadata: { inbound_lease_id: leaseId, inbound_message_id: messageId } }
        : {}),
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
      ...(leaseId
        ? { metadata: { inbound_lease_id: leaseId, inbound_message_id: messageId } }
        : {}),
    })),
  ];
  if (!rows.length) return;
  await ensureInboundJobLease(assertJobLease);
  const { error } = await supabaseAdmin.from("information_agent_fact_candidates").upsert(rows, {
    onConflict: "message_id,fact_key,evidence_asset_id,source_page,display_value",
    ignoreDuplicates: true,
  });
  if (error) throw error;
}

function normalizeRawMimeType(value: string | null): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function normalizeAttachmentMimeType(rawMimeType: string, filename: string): string {
  const alias = ATTACHMENT_MIME_ALIASES[rawMimeType];
  if (alias) return alias;
  if (ALLOWED_ATTACHMENT_MIME_TYPES.has(rawMimeType)) return rawMimeType;
  if (rawMimeType === "" || rawMimeType === "application/octet-stream") {
    const extension = filename.slice(filename.lastIndexOf(".")).toLowerCase();
    return ATTACHMENT_EXTENSION_MIME_TYPES[extension] ?? "";
  }
  return "";
}

function normalizeAttachmentDownloadUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
