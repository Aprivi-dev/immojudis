import "server-only";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Tables } from "@/integrations/supabase/types";
import { adminPageLimit, adminPageQueryShape } from "@/lib/admin-page-query";
import { adminPageMeta, type AdminPageMeta } from "@/lib/admin-pagination";
import { NotFoundError, PublicApiError } from "@/lib/api-errors";

type PublicationRequestRow = Tables<"listing_publication_requests">;
/** Colonne `status` protégée par une contrainte CHECK : le type généré est string. */
type PublicationRequest = Omit<PublicationRequestRow, "status"> & {
  status: "pending" | "approved" | "rejected";
};
type PublicationSaleInsert = Database["public"]["Tables"]["auction_sales"]["Insert"] & {
  description?: string | null;
};

const adminPublicationStatusSchema = z.enum(["all", "pending", "approved", "rejected"]);

/** Demandes de publication par page sans paramètre (plus courte que la page admin commune). */
const PUBLICATION_REQUESTS_PAGE_SIZE = 30;

export const adminPublicationQuerySchema = z.object({
  status: adminPublicationStatusSchema.default("all"),
  search: z.string().trim().max(120).default(""),
  ...adminPageQueryShape,
  limit: adminPageLimit(PUBLICATION_REQUESTS_PAGE_SIZE),
});

export type AdminPublicationQuery = z.output<typeof adminPublicationQuerySchema>;

export type AdminPublicationRequestsResponse = AdminPageMeta & {
  requests: PublicationRequest[];
  pendingCount: number;
};

export const adminPublicationReviewInputSchema = z.object({
  id: z.string().guid(),
  status: z.enum(["approved", "rejected"]),
});

export type AdminPublicationReviewInput = z.output<typeof adminPublicationReviewInputSchema>;

export type AdminPublicationReviewResponse = {
  request: PublicationRequest;
  publishedSaleId: string | null;
};

export async function listAdminPublicationRequests({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminPublicationQuery;
}): Promise<AdminPublicationRequestsResponse> {
  await assertAdminAuth(authToken);

  const search = sanitizeSearch(input.search);
  let pageQuery = supabaseAdmin
    .from("listing_publication_requests")
    .select("*", { count: "exact" });
  let pendingQuery = supabaseAdmin
    .from("listing_publication_requests")
    .select("id", { count: "exact", head: true });

  if (input.status !== "all") {
    pageQuery = pageQuery.eq("status", input.status);
  }
  if (search) {
    const filter = publicationSearchFilter(search);
    pageQuery = pageQuery.or(filter);
    pendingQuery = pendingQuery.or(filter);
  }
  pendingQuery = pendingQuery.eq("status", "pending");

  const [{ data, error, count }, { count: pendingCount, error: pendingError }] = await Promise.all([
    pageQuery
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(input.offset, input.offset + input.limit - 1),
    pendingQuery,
  ]);

  if (error) throw error;
  if (pendingError) throw pendingError;

  return {
    requests: (data ?? []) as PublicationRequest[],
    pendingCount: pendingCount ?? 0,
    ...adminPageMeta({ offset: input.offset, limit: input.limit, total: count ?? 0 }),
  };
}

export async function reviewAdminPublicationRequest({
  authToken,
  input,
}: {
  authToken: string;
  input: AdminPublicationReviewInput;
}): Promise<AdminPublicationReviewResponse> {
  const auth = await assertAdminAuth(authToken);

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("listing_publication_requests")
    .select("*")
    .eq("id", input.id)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) throw new NotFoundError("Demande de publication introuvable.");

  if (input.status === "rejected") {
    if (existing.published_sale_id) {
      throw new PublicApiError("Cette demande est déjà liée à une vente publiée.", 409);
    }
    return {
      request: await updatePublicationRequestStatus({
        id: input.id,
        status: input.status,
        reviewedBy: auth.userId,
      }),
      publishedSaleId: null,
    };
  }

  if (!existing.published_sale_id) {
    assertPublicationDateIsPublishable(existing.hearing_date);
  }
  const saleId = existing.published_sale_id ?? (await createPublicationSale(existing)).id;
  const request = await updatePublicationRequestStatus({
    id: input.id,
    status: "approved",
    reviewedBy: auth.userId,
    publishedSaleId: saleId,
    publishedAt: existing.published_at ?? new Date().toISOString(),
  });
  return { request, publishedSaleId: saleId };
}

async function updatePublicationRequestStatus({
  id,
  status,
  reviewedBy,
  publishedSaleId,
  publishedAt,
}: {
  id: string;
  status: PublicationRequest["status"];
  reviewedBy: string;
  publishedSaleId?: string;
  publishedAt?: string;
}): Promise<PublicationRequest> {
  const { data, error } = await supabaseAdmin
    .from("listing_publication_requests")
    .update({
      status,
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewedBy,
      ...(publishedSaleId ? { published_sale_id: publishedSaleId } : {}),
      ...(publishedAt ? { published_at: publishedAt } : {}),
    })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data as PublicationRequest;
}

async function createPublicationSale(
  request: PublicationRequestRow,
): Promise<Pick<Database["public"]["Tables"]["auction_sales"]["Row"], "id">> {
  assertPublicationDateIsPublishable(request.hearing_date);
  const sourceUrl = publicationSourceUrl(request.id);
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("auction_sales")
    .select("id")
    .eq("source_url", sourceUrl)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return existing;

  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    // `description` exists in the baseline SQL table but is missing from the
    // generated local Insert type; keep it in the runtime payload while the
    // generated types are refreshed.
    .insert(
      publicationSalePayload(
        request,
        sourceUrl,
      ) as Database["public"]["Tables"]["auction_sales"]["Insert"],
    )
    .select("id")
    .single();
  if (!error && data) return data;

  // A retry can race another admin approval. The deterministic source URL
  // makes the operation idempotent without overwriting a pipeline-enriched row.
  if (error?.code === "23505") {
    const { data: concurrent, error: concurrentError } = await supabaseAdmin
      .from("auction_sales")
      .select("id")
      .eq("source_url", sourceUrl)
      .maybeSingle();
    if (concurrentError) throw concurrentError;
    if (concurrent) return concurrent;
  }
  throw error ?? new Error("Publication sale insert returned no row.");
}

function publicationSalePayload(
  request: PublicationRequestRow,
  sourceUrl: string,
): PublicationSaleInsert {
  const location = request.location?.trim() || null;
  const postalCode = location?.match(/\b\d{5}\b/)?.[0] ?? null;
  const city =
    location
      ?.replace(/\b\d{5}\b/, " ")
      .replace(/\s+/g, " ")
      .trim() || null;
  const hearingDate = assertPublicationDateIsPublishable(request.hearing_date);
  const saleDate = `${hearingDate}T12:00:00.000Z`;
  const status = "upcoming";

  return {
    source_name: "publication-professionnelle",
    primary_source: "publication-professionnelle",
    source_url: sourceUrl,
    source_urls: [sourceUrl],
    title: request.title,
    description: request.description,
    city,
    postal_code: postalCode,
    tribunal: request.court,
    starting_price_eur: request.starting_price_eur,
    sale_date: saleDate,
    status,
    sale_venue_type: "unknown",
    sale_legal_framework: "unknown",
    sale_verification_status: "pending",
    property_type: "unknown",
    documents: [],
    quality_flags: ["professional_submission_pending_enrichment"],
    dedupe_confidence: "manual_publication",
    raw_payload: {
      publication_request_id: request.id,
      requester_id: request.requester_id,
      description: request.description,
      sale_date: hearingDate,
      date_precision: "day",
      sale_date_precision: "day",
      anonymize_documents: request.anonymize_documents,
      document_types: request.document_types,
      promotion_options: request.promotion_options,
      strengths: request.strengths,
      cautions: request.cautions,
    },
  };
}

export function assertPublicationDateIsPublishable(hearingDate: string | null): string {
  if (!hearingDate) {
    throw new PublicApiError("Impossible de publier cette demande sans date de vente.", 422);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(hearingDate);
  if (!match) {
    throw new PublicApiError(
      "La date de vente doit être une date civile valide au format AAAA-MM-JJ.",
      422,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new PublicApiError(
      "La date de vente doit être une date civile valide au format AAAA-MM-JJ.",
      422,
    );
  }
  const todayInParis = parisCivilDate();
  if (hearingDate < todayInParis) {
    throw new PublicApiError(
      "Impossible de publier une demande dont la date de vente est passée.",
      422,
    );
  }
  return hearingDate;
}

function parisCivilDate(now = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function publicationSourceUrl(requestId: string): string {
  // Cette URL est la clé d'idempotence de la vente publiée : elle garde l'origine qu'elle a toujours eue
  // (`NEXT_PUBLIC_SITE_URL`). La faire suivre `resolveSiteOrigin` (`SITE_URL` d'abord) détacherait les
  // ventes déjà publiées si les deux variables diffèrent ; à ne changer qu'après avoir comparé les valeurs.
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://immojudis.com";
  return `${origin.replace(/\/$/, "")}/publications/professional/${encodeURIComponent(requestId)}`;
}

function sanitizeSearch(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}@._ -]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function publicationSearchFilter(search: string): string {
  const pattern = "*" + search + "*";
  return [
    "title.ilike." + pattern,
    "location.ilike." + pattern,
    "court.ilike." + pattern,
    "requester_email.ilike." + pattern,
    "description.ilike." + pattern,
  ].join(",");
}
