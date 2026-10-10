import "server-only";
import { z } from "zod";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import type { PublicationRequestStatus } from "@/lib/publication-requests-client";

export const PUBLICATION_DOCUMENT_BUCKET = "listing-request-documents" as const;
export const PUBLICATION_DOCUMENT_URL_TTL_SECONDS = 5 * 60;
export const MAX_PUBLICATION_DOCUMENTS = 20;
export const MAX_PUBLICATION_DOCUMENT_SIZE_BYTES = 50 * 1024 * 1024;
export const PUBLICATION_REQUEST_PAGE_SIZE = 50;

const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const publicationDocumentTypeSchema = z.string().trim().min(1).max(120);
const publicationPromotionSchema = z.enum(["featured", "seo", "partners"]);
const publicationUploadDescriptorSchema = z.object({
  name: z.string().trim().min(1).max(240),
  size: z.number().int().positive().max(MAX_PUBLICATION_DOCUMENT_SIZE_BYTES),
  mime_type: z.string().trim().min(1).max(120),
});
const uploadedPublicationDocumentSchema = z.object({
  bucket: z.literal(PUBLICATION_DOCUMENT_BUCKET),
  path: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(240),
  size: z.number().int().positive().max(MAX_PUBLICATION_DOCUMENT_SIZE_BYTES),
  mime_type: z.string().trim().min(1).max(120),
  uploaded_at: z.string().trim().min(1).max(80),
});

export const publicationRequestFieldsSchema = z.object({
  title: z.string().trim().min(1).max(240),
  location: z.string().trim().min(1).max(240),
  startingPriceEur: z.number().finite().nonnegative().nullable(),
  hearingDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  court: z.string().trim().max(180).nullable(),
  description: z.string().trim().min(1).max(12_000),
  strengths: z.string().trim().max(4_000).nullable(),
  cautions: z.string().trim().max(4_000).nullable(),
  anonymizeDocuments: z.boolean(),
  documentTypes: z.array(publicationDocumentTypeSchema).max(12),
  promotionOptions: z.array(publicationPromotionSchema).max(3),
});

export type PublicationRequestFields = z.output<typeof publicationRequestFieldsSchema>;
export type PublicationUploadDescriptor = z.output<typeof publicationUploadDescriptorSchema>;

export type UploadedPublicationDocument = {
  bucket: typeof PUBLICATION_DOCUMENT_BUCKET;
  path: string;
  name: string;
  size: number;
  mime_type: string;
  uploaded_at: string;
};

export type PublicationUploadTarget = UploadedPublicationDocument & {
  token: string;
  ordinal: number;
};

export const publicationUploadRequestSchema = z.object({
  files: z.array(publicationUploadDescriptorSchema).max(MAX_PUBLICATION_DOCUMENTS),
});

export const publicationRequestFinalizeSchema = z.object({
  requestId: z.string().uuid(),
  fields: publicationRequestFieldsSchema,
  documents: z.array(uploadedPublicationDocumentSchema).max(MAX_PUBLICATION_DOCUMENTS),
});

export type PublicationDocumentView = Omit<UploadedPublicationDocument, "path" | "bucket"> & {
  signedUrl: string | null;
};

export type PublicationRequestSummary = {
  id: string;
  requesterId: string;
  requesterEmail: string | null;
  status: PublicationRequestStatus;
  title: string;
  location: string | null;
  startingPriceEur: number | null;
  hearingDate: string | null;
  court: string | null;
  description: string | null;
  strengths: string | null;
  cautions: string | null;
  anonymizeDocuments: boolean;
  documentTypes: string[];
  promotionOptions: string[];
  documentCount: number;
  adminNotes: string | null;
  publishedSaleId: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PublicationRequestDetail = PublicationRequestSummary & {
  documents: PublicationDocumentView[];
};

type PublicationRequestRow = Database["public"]["Tables"]["listing_publication_requests"]["Row"];

const PUBLICATION_REQUEST_COLUMNS =
  "id,requester_id,requester_email,status,title,location,starting_price_eur,hearing_date,court,description,strengths,cautions,anonymize_documents,document_types,promotion_options,submitted_documents,admin_notes,published_sale_id,published_at,reviewed_at,created_at,updated_at";

type PublicationProfile = {
  account_type: "b2c" | "b2b";
  professional_status: "not_applicable" | "pending" | "approved" | "rejected";
  email: string | null;
};

export async function createPublicationUploadTargets({
  auth,
  files,
}: {
  auth: SupabaseAuthContext;
  files: PublicationUploadDescriptor[];
}): Promise<{ requestId: string; uploads: PublicationUploadTarget[] }> {
  await assertApprovedProfessional(auth);
  if (files.length > MAX_PUBLICATION_DOCUMENTS) {
    throw new Error(`Vous pouvez transmettre au maximum ${MAX_PUBLICATION_DOCUMENTS} pièces.`);
  }

  const requestId = crypto.randomUUID();
  const uploads: PublicationUploadTarget[] = [];

  try {
    for (const [ordinal, file] of files.entries()) {
      validatePublicationDocumentDescriptor(file);
      const path = `${auth.userId}/${requestId}/${safeStorageFileName(file.name)}`;
      const { data, error } = await supabaseAdmin.storage
        .from(PUBLICATION_DOCUMENT_BUCKET)
        .createSignedUploadUrl(path);
      if (error || !data?.token) throw error ?? new Error("Impossible de préparer la pièce.");
      uploads.push({
        bucket: PUBLICATION_DOCUMENT_BUCKET,
        path,
        name: file.name,
        size: file.size,
        mime_type: file.mime_type,
        uploaded_at: new Date().toISOString(),
        token: data.token,
        ordinal,
      });
    }
    return { requestId, uploads };
  } catch (error) {
    await removePublicationRequestUploads({ auth, requestId });
    throw error;
  }
}

export async function finalizePublicationRequest({
  auth,
  requestId,
  fields,
  documents,
}: {
  auth: SupabaseAuthContext;
  requestId: string;
  fields: PublicationRequestFields;
  documents: UploadedPublicationDocument[];
}): Promise<{ request: PublicationRequestSummary }> {
  const requesterEmail = await assertApprovedProfessional(auth);
  const id = z.string().uuid().parse(requestId);
  if (!fields.documentTypes.length && !documents.length) {
    throw new Error("Ajoutez au moins un type de document ou une pièce transmise.");
  }
  if (documents.length > MAX_PUBLICATION_DOCUMENTS) {
    throw new Error(`Vous pouvez transmettre au maximum ${MAX_PUBLICATION_DOCUMENTS} pièces.`);
  }

  const { data: existingRequest, error: existingRequestError } = await supabaseAdmin
    .from("listing_publication_requests")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (existingRequestError) throw existingRequestError;
  if (existingRequest) {
    throw new Error("Cette demande de publication existe déjà.");
  }

  try {
    const validatedDocuments = documents.map((document) =>
      validateUploadedPublicationDocument(document, auth.userId, id),
    );
    if (
      new Set(validatedDocuments.map((document) => document.path)).size !==
      validatedDocuments.length
    ) {
      throw new Error("Une pièce est référencée plusieurs fois dans cette demande.");
    }
    await assertUploadedDocumentsExist(validatedDocuments, auth.userId, id);
    const { data, error } = await supabaseAdmin
      .from("listing_publication_requests")
      .insert({
        id,
        requester_id: auth.userId,
        requester_email: requesterEmail,
        title: fields.title,
        location: fields.location,
        starting_price_eur: fields.startingPriceEur,
        hearing_date: fields.hearingDate,
        court: fields.court,
        description: fields.description,
        strengths: fields.strengths,
        cautions: fields.cautions,
        anonymize_documents: fields.anonymizeDocuments,
        document_types: fields.documentTypes,
        promotion_options: fields.promotionOptions,
        submitted_documents: validatedDocuments as unknown as Json,
      })
      .select(PUBLICATION_REQUEST_COLUMNS)
      .single();

    if (error) throw error;
    return { request: publicationRequestToSummary(data as PublicationRequestRow) };
  } catch (error) {
    const { data: insertedRequest } = await supabaseAdmin
      .from("listing_publication_requests")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (!insertedRequest) await removePublicationRequestUploads({ auth, requestId: id });
    throw error;
  }
}

export async function listPublicationRequests({
  auth,
  page = 1,
}: {
  auth: SupabaseAuthContext;
  page?: number;
}): Promise<{
  requests: PublicationRequestSummary[];
  page: number;
  hasMore: boolean;
  nextPage: number | null;
}> {
  const safePage = z.number().int().min(1).max(100_000).parse(page);
  const start = (safePage - 1) * PUBLICATION_REQUEST_PAGE_SIZE;
  let query = supabaseAdmin
    .from("listing_publication_requests")
    .select(PUBLICATION_REQUEST_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(start, start + PUBLICATION_REQUEST_PAGE_SIZE);
  if (!auth.isAdmin) query = query.eq("requester_id", auth.userId);

  const { data, error } = await query;
  if (error) throw error;
  const rows = (data ?? []) as PublicationRequestRow[];
  const hasMore = rows.length > PUBLICATION_REQUEST_PAGE_SIZE;
  return {
    requests: rows.slice(0, PUBLICATION_REQUEST_PAGE_SIZE).map(publicationRequestToSummary),
    page: safePage,
    hasMore,
    nextPage: hasMore ? safePage + 1 : null,
  };
}

export async function getPublicationRequest({
  auth,
  requestId,
}: {
  auth: SupabaseAuthContext;
  requestId: string;
}): Promise<{ request: PublicationRequestDetail }> {
  const id = z.string().uuid().parse(requestId);
  let query = supabaseAdmin
    .from("listing_publication_requests")
    .select(PUBLICATION_REQUEST_COLUMNS)
    .eq("id", id);
  if (!auth.isAdmin) query = query.eq("requester_id", auth.userId);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("NotFound: demande de publication introuvable.");

  const row = data as PublicationRequestRow;
  const documents = await signedPublicationDocuments(row);
  return {
    request: {
      ...publicationRequestToSummary(row),
      documents,
    },
  };
}

export async function assertApprovedProfessional(auth: SupabaseAuthContext): Promise<string> {
  const claimEmail = normalizeEmail(auth.claims.email);
  if (!claimEmail) {
    throw new Error("Forbidden: une adresse email confirmée est obligatoire avant tout dépôt.");
  }
  if (auth.isAdmin) return claimEmail;

  const { data, error } = await auth.supabase
    .from("user_profiles")
    .select("account_type,professional_status,email")
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (error) throw error;
  const profile = data as PublicationProfile | null;
  if (!profile || profile.account_type !== "b2b") {
    throw new Error("Forbidden: ce dépôt est réservé aux comptes professionnels.");
  }
  if (profile.professional_status === "pending") {
    throw new Error("Forbidden: votre compte professionnel est encore en attente de validation.");
  }
  if (profile.professional_status !== "approved") {
    throw new Error(
      "Forbidden: votre compte professionnel n'est pas autorisé à déposer une vente.",
    );
  }
  return claimEmail;
}

function publicationRequestToSummary(row: PublicationRequestRow): PublicationRequestSummary {
  const documents = uploadedDocumentsFromJson(row.submitted_documents);
  return {
    id: row.id,
    requesterId: row.requester_id,
    requesterEmail: row.requester_email,
    status: row.status as PublicationRequestStatus,
    title: row.title,
    location: row.location,
    startingPriceEur: row.starting_price_eur,
    hearingDate: row.hearing_date,
    court: row.court,
    description: row.description,
    strengths: row.strengths,
    cautions: row.cautions,
    anonymizeDocuments: row.anonymize_documents,
    documentTypes: row.document_types,
    promotionOptions: row.promotion_options,
    documentCount: documents.length,
    adminNotes: row.admin_notes,
    publishedSaleId: row.published_sale_id,
    publishedAt: row.published_at,
    publishedUrl: row.published_sale_id
      ? `/sales/${encodeURIComponent(row.published_sale_id)}`
      : null,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function signedPublicationDocuments(
  row: PublicationRequestRow,
): Promise<PublicationDocumentView[]> {
  const documents = uploadedDocumentsFromJson(row.submitted_documents);
  return Promise.all(
    documents.map(async (document) => {
      const isOwnedPath = document.path.startsWith(`${row.requester_id}/`);
      if (document.bucket !== PUBLICATION_DOCUMENT_BUCKET || !isOwnedPath) {
        return {
          name: document.name,
          size: document.size,
          mime_type: document.mime_type,
          uploaded_at: document.uploaded_at,
          signedUrl: null,
        };
      }
      const { data } = await supabaseAdmin.storage
        .from(PUBLICATION_DOCUMENT_BUCKET)
        .createSignedUrl(document.path, PUBLICATION_DOCUMENT_URL_TTL_SECONDS);
      return {
        name: document.name,
        size: document.size,
        mime_type: document.mime_type,
        uploaded_at: document.uploaded_at,
        signedUrl: data?.signedUrl ?? null,
      };
    }),
  );
}

function uploadedDocumentsFromJson(value: Json): UploadedPublicationDocument[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isUploadedPublicationDocument);
}

function isUploadedPublicationDocument(value: Json): value is UploadedPublicationDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, Json | undefined>;
  return (
    candidate.bucket === PUBLICATION_DOCUMENT_BUCKET &&
    typeof candidate.path === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.mime_type === "string" &&
    typeof candidate.uploaded_at === "string"
  );
}

function validatePublicationDocumentDescriptor(file: PublicationUploadDescriptor): void {
  if (!file.name.trim()) throw new Error("Une pièce transmise doit avoir un nom.");
  if (!ALLOWED_DOCUMENT_MIME_TYPES.has(file.mime_type)) {
    throw new Error("Format de pièce non accepté. Utilisez un PDF, JPG, PNG, WebP, HEIC ou HEIF.");
  }
  if (
    !Number.isInteger(file.size) ||
    file.size <= 0 ||
    file.size > MAX_PUBLICATION_DOCUMENT_SIZE_BYTES
  ) {
    throw new Error("Chaque pièce doit peser entre 1 octet et 50 Mo.");
  }
}

function validateUploadedPublicationDocument(
  document: UploadedPublicationDocument,
  userId: string,
  requestId: string,
): UploadedPublicationDocument {
  validatePublicationDocumentDescriptor({
    name: document.name,
    size: document.size,
    mime_type: document.mime_type,
  });
  const prefix = `${userId}/${requestId}/`;
  if (document.bucket !== PUBLICATION_DOCUMENT_BUCKET || !document.path.startsWith(prefix)) {
    throw new Error("La pièce transmise ne correspond pas à cette demande.");
  }
  if (document.path.includes("..") || document.path.endsWith("/")) {
    throw new Error("Le chemin de la pièce transmise est invalide.");
  }
  return document;
}

async function assertUploadedDocumentsExist(
  documents: UploadedPublicationDocument[],
  userId: string,
  requestId: string,
): Promise<void> {
  if (!documents.length) return;
  const { data, error } = await supabaseAdmin.storage
    .from(PUBLICATION_DOCUMENT_BUCKET)
    .list(`${userId}/${requestId}`, { limit: MAX_PUBLICATION_DOCUMENTS });
  if (error) throw error;
  const available = new Set((data ?? []).map((file) => file.name));
  const missing = documents.some((document) => {
    const name = document.path.slice(document.path.lastIndexOf("/") + 1);
    return !available.has(name);
  });
  if (missing)
    throw new Error("Une pièce n'a pas été téléversée correctement. Recommencez le dépôt.");
}

export async function removePublicationRequestUploads({
  auth,
  requestId,
}: {
  auth: SupabaseAuthContext;
  requestId: string;
}): Promise<void> {
  const id = z.string().uuid().parse(requestId);
  const { data: existingRequest, error: existingRequestError } = await supabaseAdmin
    .from("listing_publication_requests")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (existingRequestError) throw existingRequestError;
  if (existingRequest) return;

  const folder = `${auth.userId}/${id}`;
  const { data } = await supabaseAdmin.storage
    .from(PUBLICATION_DOCUMENT_BUCKET)
    .list(folder, { limit: MAX_PUBLICATION_DOCUMENTS });
  const paths = (data ?? []).map((file) => `${folder}/${file.name}`);
  if (!paths.length) return;
  await supabaseAdmin.storage
    .from(PUBLICATION_DOCUMENT_BUCKET)
    .remove(paths)
    .catch(() => undefined);
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function safeStorageFileName(fileName: string): string {
  const cleanName = fileName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-140);
  return `${crypto.randomUUID()}-${cleanName || "document"}`;
}
