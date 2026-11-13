import { apiFetch, apiRequest } from "@/lib/client-api-core";
import { supabase } from "@/integrations/supabase/client";

export type PublicationRequestStatus = "pending" | "approved" | "rejected";

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

export type PublicationDocumentView = {
  name: string;
  size: number;
  mime_type: string;
  uploaded_at: string;
  signedUrl: string | null;
};

export type PublicationRequestDetail = PublicationRequestSummary & {
  documents: PublicationDocumentView[];
};

type PublicationRequestListResponse = {
  requests: PublicationRequestSummary[];
  page: number;
  hasMore: boolean;
  nextPage: number | null;
};

type PublicationUploadTarget = {
  requestId: string;
  uploads: Array<{
    bucket: string;
    path: string;
    token: string;
    name: string;
    size: number;
    mime_type: string;
    uploaded_at: string;
    ordinal: number;
  }>;
};

export type PublicationRequestFields = {
  title: string;
  location: string;
  startingPrice: string;
  hearingDate: string;
  court: string;
  description: string;
  strengths: string;
  cautions: string;
  anonymizeDocuments: boolean;
  documentTypes: string[];
  promotionOptions: string[];
  files: File[];
};

export function fetchPublicationRequestsClient(page = 1): Promise<PublicationRequestListResponse> {
  return apiRequest(`/api/publication-requests?page=${page}`);
}

export async function fetchAllPublicationRequestsClient(): Promise<{
  requests: PublicationRequestSummary[];
}> {
  const requests: PublicationRequestSummary[] = [];
  let page = 1;
  while (true) {
    const response = await fetchPublicationRequestsClient(page);
    requests.push(...response.requests);
    if (!response.hasMore || !response.nextPage) return { requests };
    page = response.nextPage;
    if (page > 100_000) throw new Error("La pagination des demandes est invalide.");
  }
}

export function fetchPublicationRequestClient(
  requestId: string,
): Promise<{ request: PublicationRequestDetail }> {
  return apiRequest(`/api/publication-requests/${encodeURIComponent(requestId)}`);
}

export async function submitPublicationRequestClient(
  fields: PublicationRequestFields,
): Promise<{ request: PublicationRequestSummary }> {
  const uploadTarget = await apiRequest<PublicationUploadTarget>("/api/publication-requests", {
    method: "PUT",
    body: {
      files: fields.files.map((file) => ({
        name: file.name,
        size: file.size,
        mime_type: file.type,
      })),
    },
  });

  try {
    const documents = [];
    for (const target of uploadTarget.uploads) {
      const file = fields.files[target.ordinal];
      if (!file) throw new Error("Une pièce préparée est introuvable dans le formulaire.");
      const { error } = await supabase.storage
        .from(target.bucket)
        .uploadToSignedUrl(target.path, target.token, file);
      if (error) throw new Error(`Téléversement de « ${file.name} » impossible.`);
      documents.push({
        bucket: target.bucket,
        path: target.path,
        name: file.name,
        size: file.size,
        mime_type: file.type,
        uploaded_at: target.uploaded_at,
      });
    }

    return await apiRequest<{ request: PublicationRequestSummary }>("/api/publication-requests", {
      method: "POST",
      body: {
        requestId: uploadTarget.requestId,
        fields: {
          title: fields.title,
          location: fields.location,
          startingPriceEur: parseEuroAmount(fields.startingPrice),
          hearingDate: emptyToNull(fields.hearingDate),
          court: emptyToNull(fields.court),
          description: fields.description,
          strengths: emptyToNull(fields.strengths),
          cautions: emptyToNull(fields.cautions),
          anonymizeDocuments: fields.anonymizeDocuments,
          documentTypes: fields.documentTypes,
          promotionOptions: fields.promotionOptions,
        },
        documents,
      },
    });
  } catch (error) {
    await cleanupPublicationRequestUploads(uploadTarget.requestId);
    throw error;
  }
}

async function cleanupPublicationRequestUploads(requestId: string): Promise<void> {
  await apiFetch("/api/publication-requests", { method: "DELETE", body: { requestId } }).catch(
    () => undefined,
  );
}

function emptyToNull(value: string): string | null {
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function parseEuroAmount(value: string): number | null {
  const normalized = value
    .replace(/\s/g, "")
    .replace(/[^\d.,-]/g, "")
    .replace(",", ".");
  if (!normalized) return null;
  const amount = Number.parseFloat(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
