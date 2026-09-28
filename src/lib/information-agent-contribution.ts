import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { safeExternalHttpUrl } from "@/lib/external-url";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { resolveSiteOrigin } from "@/lib/site-url";
import {
  extractInformationAgentFacts,
  persistFactCandidates,
} from "@/lib/information-agent-inbound";
import {
  createInformationAgentContributionToken,
  verifyInformationAgentContributionToken,
} from "./information-agent-contribution-token";

const BUCKET = "information-agent-evidence";
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SUBMISSION_BYTES = 40 * 1024 * 1024;
const MAX_FILES = 10;
const UPLOAD_TICKET_LIFETIME_MS = 2 * 60 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "text/plain",
]);

type Mission = Database["public"]["Tables"]["information_agent_missions"]["Row"];
type InformationCase = Database["public"]["Tables"]["information_agent_cases"]["Row"];

export type ContributionSession = {
  mission: Mission;
  informationCase: InformationCase;
};

export class InformationAgentContributionError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "InformationAgentContributionError";
  }
}

export const prepareContributionUploadSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  filename: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().max(100),
  size: z.number().int().min(1).max(MAX_FILE_BYTES),
});

const submittedFileSchema = z.object({
  path: z.string().min(1).max(500),
  filename: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().max(100),
  size: z.number().int().min(1).max(MAX_FILE_BYTES),
  ticket: z.string().regex(/^\d{13}\.[a-f0-9]{64}$/),
});

export const submitContributionSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  submissionId: z.string().uuid(),
  senderName: z.string().trim().min(2).max(180),
  senderEmail: z.string().trim().email().max(320),
  note: z.string().trim().max(10000).default(""),
  externalLinks: z.array(z.string().trim().max(2048)).max(5).default([]),
  authorizedToTransmit: z.literal(true),
  files: z.array(submittedFileSchema).max(MAX_FILES).default([]),
});

export type SubmitContributionInput = z.output<typeof submitContributionSchema>;

export function informationAgentContributionUrl(
  mission: Pick<Mission, "id" | "created_at">,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const origin = resolveSiteOrigin(env);
  const secret = contributionSecret(env);
  if (!origin) throw new Error("Origine du site indisponible pour le lien de dépôt.");
  if (new URL(origin).protocol !== "https:") {
    throw new InformationAgentContributionError(
      "Le dépôt sécurisé nécessite une adresse HTTPS pour le site.",
      503,
    );
  }
  const token = createInformationAgentContributionToken(mission.id, mission.created_at, secret);
  if (
    !verifyInformationAgentContributionToken({
      missionId: mission.id,
      createdAt: mission.created_at,
      token,
      secret,
    })
  ) {
    throw new InformationAgentContributionError(
      "Ce brouillon est trop ancien ; créez une nouvelle demande.",
      410,
    );
  }
  // The fragment is not sent to the server in the initial HTTP request.
  return `${origin}/contribuer/${mission.id}#${token}`;
}

export async function loadInformationAgentContribution(
  missionId: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ContributionSession> {
  if (!z.string().uuid().safeParse(missionId).success || !/^[a-f0-9]{64}$/.test(token)) {
    throw new InformationAgentContributionError("Lien de dépôt invalide.", 404);
  }
  const secret = contributionSecret(env);
  const { data: mission, error: missionError } = await supabaseAdmin
    .from("information_agent_missions")
    .select("*")
    .eq("id", missionId)
    .maybeSingle();
  if (missionError) throw missionError;
  if (
    !mission ||
    !mission.case_id ||
    !verifyInformationAgentContributionToken({
      missionId: mission.id,
      createdAt: mission.created_at,
      token,
      secret,
    })
  ) {
    throw new InformationAgentContributionError("Lien de dépôt invalide ou expiré.", 404);
  }
  if (!["sending", "sent", "replied"].includes(mission.status)) {
    throw new InformationAgentContributionError("Ce dossier n'accepte plus de dépôt.", 410);
  }
  const { data: informationCase, error: caseError } = await supabaseAdmin
    .from("information_agent_cases")
    .select("*")
    .eq("id", mission.case_id)
    .maybeSingle();
  if (caseError) throw caseError;
  if (
    !informationCase ||
    !["sending", "sent", "replied", "review"].includes(informationCase.status)
  ) {
    throw new InformationAgentContributionError("Ce dossier n'accepte plus de dépôt.", 410);
  }
  if (informationCase.initiator_mission_id && informationCase.initiator_mission_id !== mission.id) {
    throw new InformationAgentContributionError("Lien de dépôt invalide.", 404);
  }
  return { mission, informationCase };
}

export async function prepareInformationAgentContributionUpload({
  missionId,
  input,
  env = process.env,
}: {
  missionId: string;
  input: z.output<typeof prepareContributionUploadSchema>;
  env?: NodeJS.ProcessEnv;
}) {
  const { informationCase } = await loadInformationAgentContribution(missionId, input.token, env);
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new InformationAgentContributionError("Format de fichier non pris en charge.", 400);
  }
  await enforceContributionRateLimit(informationCase, "prepare", 16, 24 * 60 * 60);
  const safeName = storageFilename(input.filename);
  const path = `${informationCase.id}/portal/${randomUUID()}/${safeName}`;
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data?.token) throw error ?? new Error("Autorisation de dépôt indisponible.");
  return {
    bucket: BUCKET,
    path,
    token: data.token,
    ticket: createUploadTicket(
      informationCase.id,
      path,
      input.filename,
      input.size,
      input.mimeType,
      env,
    ),
  };
}

export async function submitInformationAgentContribution({
  missionId,
  input,
  env = process.env,
}: {
  missionId: string;
  input: SubmitContributionInput;
  env?: NodeJS.ProcessEnv;
}) {
  const { mission, informationCase } = await loadInformationAgentContribution(
    missionId,
    input.token,
    env,
  );
  if (!input.note && !input.files.length && !input.externalLinks.length) {
    throw new InformationAgentContributionError("Ajoutez une réponse, un lien ou un fichier.", 400);
  }
  if (input.files.reduce((total, file) => total + file.size, 0) > MAX_SUBMISSION_BYTES) {
    throw new InformationAgentContributionError("Le dépôt dépasse 40 Mo au total.", 400);
  }
  if (new Set(input.files.map((file) => file.path)).size !== input.files.length) {
    throw new InformationAgentContributionError(
      "Une pièce figure plusieurs fois dans le dépôt.",
      400,
    );
  }
  const links = input.externalLinks.map((value) => safeExternalHttpUrl(value));
  if (links.some((value) => !value)) {
    throw new InformationAgentContributionError(
      "Un lien externe n'est pas une URL HTTP valide.",
      400,
    );
  }
  const normalizedLinks = links.filter((value): value is string => Boolean(value));
  const bodyText = [
    input.note || "Pièces ou liens déposés pour ce dossier.",
    ...normalizedLinks.map((value) => `Lien transmis : ${value}`),
  ].join("\n\n");
  if (bodyText.length > 16000) {
    throw new InformationAgentContributionError("La réponse est trop longue.", 400);
  }
  await enforceContributionRateLimit(informationCase, "submit", 8, 24 * 60 * 60);

  const validatedFiles: Array<{
    path: string;
    filename: string;
    mimeType: string;
    size: number;
    sha256: string;
  }> = [];
  for (const file of input.files) {
    if (
      !ALLOWED_MIME_TYPES.has(file.mimeType) ||
      !file.path.startsWith(`${informationCase.id}/portal/`) ||
      !verifyUploadTicket(informationCase.id, file, env)
    ) {
      throw new InformationAgentContributionError(
        "Autorisation de fichier invalide ou expirée.",
        400,
      );
    }
    const { data: downloaded, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .download(file.path);
    if (error || !downloaded) {
      throw new InformationAgentContributionError("Le fichier déposé est introuvable.", 400);
    }
    if (downloaded.size !== file.size || downloaded.size > MAX_FILE_BYTES) {
      await discardInvalidUpload(file.path);
      throw new InformationAgentContributionError("La taille du fichier ne correspond pas.", 400);
    }
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    if (!matchesFileSignature(bytes, file.mimeType)) {
      await discardInvalidUpload(file.path);
      throw new InformationAgentContributionError(
        "Le contenu du fichier ne correspond pas à son format.",
        400,
      );
    }
    validatedFiles.push({
      path: file.path,
      filename: displayFilename(file.filename),
      mimeType: file.mimeType,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const submissionHash = createHash("sha256")
    .update(
      JSON.stringify({
        bodyText,
        senderName: input.senderName,
        senderEmail: input.senderEmail,
        files: validatedFiles,
      }),
    )
    .digest("hex");
  const senderMatches =
    input.senderEmail.toLowerCase() === informationCase.normalized_recipient_email;
  const messageId = await insertOrLoadPortalMessage({
    mission,
    informationCase,
    input,
    bodyText,
    submissionHash,
    senderMatches,
    links: normalizedLinks,
  });

  const assets = [] as Array<{
    id: string;
    filename: string;
    mimeType: string;
    storagePath: string;
    size: number;
  }>;
  for (const file of validatedFiles) {
    const { data: inserted, error } = await supabaseAdmin
      .from("information_agent_evidence_assets")
      .insert({
        case_id: informationCase.id,
        message_id: messageId,
        sale_id: informationCase.sale_id,
        provider_attachment_id: `portal:${file.path}`,
        storage_bucket: BUCKET,
        storage_path: file.path,
        original_filename: file.filename,
        mime_type: file.mimeType,
        size_bytes: file.size,
        sha256: file.sha256,
        rights_status: "unverified",
        metadata: {
          channel: "portal",
          sender_name: input.senderName,
          sender_email: input.senderEmail,
          sender_identity_verified: false,
          authorized_to_transmit_attested: true,
        },
      })
      .select("id")
      .single();
    if (error) {
      const { data: existing, error: existingError } = await supabaseAdmin
        .from("information_agent_evidence_assets")
        .select("id,case_id,message_id,sha256")
        .eq("storage_path", file.path)
        .maybeSingle();
      if (
        existingError ||
        !existing ||
        existing.case_id !== informationCase.id ||
        existing.message_id !== messageId ||
        existing.sha256 !== file.sha256
      ) {
        throw error;
      }
      assets.push({
        id: existing.id,
        filename: file.filename,
        mimeType: file.mimeType,
        storagePath: file.path,
        size: file.size,
      });
    } else {
      assets.push({
        id: inserted.id,
        filename: file.filename,
        mimeType: file.mimeType,
        storagePath: file.path,
        size: file.size,
      });
    }
  }

  await persistFactCandidates({
    sharedCase: informationCase,
    messageId,
    facts: extractInformationAgentFacts(input.note),
    assets,
  });

  const now = new Date().toISOString();
  const { data: updatedCase, error: caseUpdateError } = await supabaseAdmin
    .from("information_agent_cases")
    .update({ status: "review", replied_at: now })
    .eq("id", informationCase.id)
    .in("status", ["sending", "sent", "replied", "review"])
    .select("id")
    .maybeSingle();
  if (caseUpdateError) throw caseUpdateError;
  if (!updatedCase) {
    throw new InformationAgentContributionError(
      "Ce dossier a été fermé pendant le dépôt. Sa contribution reste conservée pour contrôle.",
      409,
    );
  }
  const { error: missionUpdateError } = await supabaseAdmin
    .from("information_agent_missions")
    .update({ status: "replied", replied_at: now })
    .eq("case_id", informationCase.id)
    .in("status", ["sending", "sent", "subscribed", "replied"]);
  if (missionUpdateError) throw missionUpdateError;

  return { messageId, assetCount: assets.length, senderMatches, assets };
}

async function discardInvalidUpload(path: string): Promise<void> {
  try {
    await supabaseAdmin.storage.from(BUCKET).remove([path]);
  } catch {
    // Keep the validation error. A failed private-object cleanup can be
    // reconciled later without making an invalid upload publishable.
  }
}

async function insertOrLoadPortalMessage({
  mission,
  informationCase,
  input,
  bodyText,
  submissionHash,
  senderMatches,
  links,
}: {
  mission: Mission;
  informationCase: InformationCase;
  input: SubmitContributionInput;
  bodyText: string;
  submissionHash: string;
  senderMatches: boolean;
  links: string[];
}): Promise<string> {
  const providerMessageId = `portal:${input.submissionId}`;
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("id,case_id,metadata")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    assertSameSubmission(existing, informationCase.id, submissionHash);
    return existing.id;
  }
  const id = randomUUID();
  const { error } = await supabaseAdmin.from("information_agent_messages").insert({
    id,
    mission_id: mission.id,
    case_id: informationCase.id,
    user_id: mission.user_id,
    direction: "inbound",
    message_kind: "reply",
    delivery_status: "received",
    from_email: input.senderEmail,
    to_email: null,
    subject: `Contribution au dossier ${informationCase.id.slice(0, 8)}`,
    body_text: bodyText,
    provider_message_id: providerMessageId,
    received_at: new Date().toISOString(),
    metadata: {
      channel: "portal",
      content_trust: "untrusted",
      sender_name: input.senderName,
      sender_matches_recipient: senderMatches,
      sender_identity_verified: false,
      external_links: links,
      submission_hash: submissionHash,
      authorized_to_transmit_attested: true,
    },
  });
  if (!error) return id;
  const { data: concurrent, error: concurrentError } = await supabaseAdmin
    .from("information_agent_messages")
    .select("id,case_id,metadata")
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (concurrentError || !concurrent) throw error;
  assertSameSubmission(concurrent, informationCase.id, submissionHash);
  return concurrent.id;
}

function assertSameSubmission(
  message: { case_id: string | null; metadata: unknown },
  caseId: string,
  submissionHash: string,
) {
  const metadata = message.metadata;
  if (
    message.case_id !== caseId ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    (metadata as Record<string, unknown>).submission_hash !== submissionHash
  ) {
    throw new InformationAgentContributionError(
      "Ce dépôt a déjà été utilisé pour un autre contenu.",
      409,
    );
  }
}

function createUploadTicket(
  caseId: string,
  path: string,
  filename: string,
  size: number,
  mimeType: string,
  env: NodeJS.ProcessEnv,
): string {
  const issuedAt = Date.now();
  const digest = createHmac("sha256", contributionSecret(env))
    .update(JSON.stringify([caseId, path, filename, size, mimeType, issuedAt]))
    .digest("hex");
  return `${issuedAt}.${digest}`;
}

function verifyUploadTicket(
  caseId: string,
  file: z.output<typeof submittedFileSchema>,
  env: NodeJS.ProcessEnv,
): boolean {
  const [issuedText, digest] = file.ticket.split(".");
  const issuedAt = Number(issuedText);
  if (
    !Number.isSafeInteger(issuedAt) ||
    issuedAt > Date.now() ||
    Date.now() - issuedAt > UPLOAD_TICKET_LIFETIME_MS
  ) {
    return false;
  }
  const expected = createHmac("sha256", contributionSecret(env))
    .update(JSON.stringify([caseId, file.path, file.filename, file.size, file.mimeType, issuedAt]))
    .digest("hex");
  return timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(expected, "hex"));
}

function storageFilename(value: string): string {
  const filename = value.split(/[\\/]/).at(-1) ?? "piece";
  const safe = filename
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .slice(0, 120);
  return safe && safe !== "." && safe !== ".." ? safe : "piece";
}

function displayFilename(value: string): string {
  return (
    [...(value.split(/[\\/]/).at(-1) ?? "pièce")]
      .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          codePoint >= 32 &&
          codePoint !== 127 &&
          !(codePoint >= 0x80 && codePoint <= 0x9f) &&
          !(codePoint >= 0x202a && codePoint <= 0x202e) &&
          !(codePoint >= 0x2066 && codePoint <= 0x2069)
        );
      })
      .join("")
      .trim()
      .slice(0, 180) || "pièce"
  );
}

export function matchesFileSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (!bytes.length) return false;
  if (mimeType === "application/pdf") {
    return bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
  }
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    );
  }
  if (mimeType === "image/webp") {
    return (
      bytes.length >= 12 &&
      new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
    );
  }
  if (mimeType === "image/heic" || mimeType === "image/heif") {
    if (bytes.length < 12 || new TextDecoder().decode(bytes.subarray(4, 8)) !== "ftyp")
      return false;
    return ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(
      new TextDecoder().decode(bytes.subarray(8, 12)),
    );
  }
  if (mimeType === "text/plain") {
    if (bytes.subarray(0, 4096).includes(0)) return false;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function enforceContributionRateLimit(
  informationCase: InformationCase,
  action: "prepare" | "submit",
  limit: number,
  windowSeconds: number,
) {
  try {
    await enforceUserRateLimit({
      userId: informationCase.created_by,
      bucketKey: `information-agent-portal:${informationCase.id}:${action}`,
      limit,
      windowSeconds,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Trop de demandes")) {
      throw new InformationAgentContributionError(
        "Limite de dépôts atteinte pour ce dossier.",
        429,
      );
    }
    throw error;
  }
}

function contributionSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.INFORMATION_AGENT_PORTAL_SECRET?.trim();
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new InformationAgentContributionError("Dépôt temporairement indisponible.", 503);
  }
  return secret;
}
