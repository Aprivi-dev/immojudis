"use client";

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import { useState } from "react";
import { toast } from "sonner";
import { AdminPanel, AdminSectionHeading, AdminShell } from "@/components/admin/AdminShell";
import { formatDateTime, formatPrice, queryErrorMessage } from "@/components/admin/admin-format";
import { EmptyState, useAdminRefresh } from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import type { Json, Tables } from "@/integrations/supabase/types";
import { fetchAdminPublicationRequests, reviewAdminPublicationRequest } from "@/lib/client-api";

type PublicationRequestStatus = "pending" | "approved" | "rejected";
// The `status` column is guarded by a CHECK constraint: the generated type is a plain string.
type PublicationRequest = Omit<Tables<"listing_publication_requests">, "status"> & {
  status: PublicationRequestStatus;
};
type PublicationFilter = "all" | PublicationRequestStatus;

type UploadedPublicationDocument = {
  bucket?: string;
  path?: string;
  name?: string;
  size?: number;
  mime_type?: string;
  uploaded_at?: string;
};

const PUBLICATION_DOCUMENT_BUCKET = "listing-request-documents";
const PUBLICATION_PAGE_SIZE = 30;

export function AdminPublicationsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [publicationStatus, setPublicationStatus] = useState<PublicationFilter>("all");
  const publicationSearch = searchQuery.trim();
  const { isRefreshing, refresh } = useAdminRefresh(["admin-publication-requests"]);

  const publicationRequestsQuery = useInfiniteQuery({
    queryKey: ["admin-publication-requests", publicationStatus, publicationSearch],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      fetchAdminPublicationRequests({
        status: publicationStatus,
        search: publicationSearch,
        offset: pageParam,
        limit: PUBLICATION_PAGE_SIZE,
      }),
    getNextPageParam: (page) =>
      page.hasMore && page.requests.length ? page.offset + page.requests.length : undefined,
    staleTime: 30_000,
    retry: 1,
  });
  const publicationPage = publicationRequestsQuery.data?.pages.at(-1);
  const publicationRequests =
    publicationRequestsQuery.data?.pages.flatMap((page) => page.requests) ?? [];

  const reviewMutation = useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: Extract<PublicationRequestStatus, "approved" | "rejected">;
    }) => reviewAdminPublicationRequest({ id, status }),
    onSuccess: async (result, variables) => {
      toast.success(
        variables.status === "approved"
          ? result.publishedSaleId
            ? "Demande validée : vente créée, enrichissement à terminer."
            : "Demande validée."
          : "Demande refusée.",
      );
      await queryClient.invalidateQueries({ queryKey: ["admin-publication-requests"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Impossible de mettre à jour la demande");
    },
  });

  return (
    <AdminShell
      activeSection="publications"
      title="Publications"
      description="Contrôlez les annonces professionnelles avant leur mise en ligne."
      adminEmail={user?.email}
      searchValue={searchQuery}
      searchPlaceholder="Titre, ville, tribunal…"
      onSearchChange={setSearchQuery}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      <AdminPublications
        requests={publicationRequests}
        totalRequests={publicationPage?.totalCount ?? null}
        pendingCount={publicationPage?.pendingCount ?? null}
        loading={publicationRequestsQuery.isLoading}
        error={publicationRequestsQuery.error}
        fetching={publicationRequestsQuery.isFetching}
        hasMore={publicationRequestsQuery.hasNextPage}
        onLoadMore={() => void publicationRequestsQuery.fetchNextPage()}
        onRetry={() => void publicationRequestsQuery.refetch()}
        filter={publicationStatus}
        onFilterChange={setPublicationStatus}
        reviewPending={reviewMutation.isPending}
        onReview={(id, status) => reviewMutation.mutate({ id, status })}
      />
    </AdminShell>
  );
}

function AdminPublications({
  requests,
  totalRequests,
  pendingCount,
  loading,
  fetching,
  error,
  hasMore,
  onLoadMore,
  onRetry,
  filter,
  onFilterChange,
  reviewPending,
  onReview,
}: {
  requests: PublicationRequest[];
  totalRequests: number | null;
  pendingCount: number | null;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  hasMore: boolean;
  onLoadMore: () => void;
  onRetry: () => void;
  filter: PublicationFilter;
  onFilterChange: (filter: PublicationFilter) => void;
  reviewPending: boolean;
  onReview: (
    id: string,
    status: Extract<PublicationRequestStatus, "approved" | "rejected">,
  ) => void;
}) {
  return (
    <AdminPanel className="overflow-hidden">
      <div className="border-b border-brand-navy/10 p-5">
        <AdminSectionHeading
          title="File de validation"
          description={
            pendingCount == null || totalRequests == null
              ? "Nombre de demandes indisponible"
              : filter === "all"
                ? `${pendingCount} demande${pendingCount > 1 ? "s" : ""} en attente sur ${totalRequests}`
                : `${totalRequests} demande${totalRequests > 1 ? "s" : ""} correspondant au filtre sélectionné`
          }
          action={
            <div className="flex flex-wrap gap-1 rounded-lg bg-brand-navy/[0.04] p-1">
              {(
                [
                  ["all", "Toutes"],
                  ["pending", "En attente"],
                  ["approved", "Validées"],
                  ["rejected", "Refusées"],
                ] as Array<[PublicationFilter, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => onFilterChange(value)}
                  className={`rounded-md px-3 py-2 text-xs font-semibold transition ${
                    filter === value
                      ? "bg-white text-brand-navy shadow-sm"
                      : "text-brand-navy/55 hover:text-brand-navy"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        />
      </div>

      {error ? (
        <div
          className="m-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"
          role="alert"
        >
          <p>
            {requests.length
              ? "Actualisation impossible. Les demandes affichées peuvent être obsolètes."
              : queryErrorMessage(error, "Erreur de chargement des demandes")}
          </p>
          <button
            type="button"
            className="admin-button-secondary mt-3"
            onClick={onRetry}
            disabled={loading}
          >
            {loading ? "Nouvelle tentative…" : "Réessayer"}
          </button>
        </div>
      ) : null}

      <div className="grid gap-3 p-5">
        {loading ? (
          <EmptyState label="Chargement des demandes de publication" />
        ) : requests.length ? (
          requests.map((request) => (
            <PublicationRequestCard
              key={request.id}
              request={request}
              disabled={reviewPending}
              onReview={(status) => onReview(request.id, status)}
            />
          ))
        ) : (
          <div className="py-16 text-center text-sm text-brand-navy/58">
            {error
              ? "Les demandes sont indisponibles pour le moment."
              : "Aucune demande ne correspond aux filtres."}
          </div>
        )}
        {hasMore && !loading && !error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-brand-navy/10 pt-4">
            <span className="text-xs text-brand-navy/58">
              {requests.length} demande{requests.length > 1 ? "s" : ""} affichée
              {requests.length > 1 ? "s" : ""}
              {totalRequests != null ? " sur " + totalRequests : ""} · filtre et recherche serveur
            </span>
            <button
              type="button"
              className="admin-button-secondary"
              onClick={onLoadMore}
              disabled={fetching}
            >
              {fetching ? "Chargement…" : `Charger ${PUBLICATION_PAGE_SIZE} de plus`}
            </button>
          </div>
        ) : null}
      </div>
    </AdminPanel>
  );
}

function PublicationRequestCard({
  request,
  disabled,
  onReview,
}: {
  request: PublicationRequest;
  disabled: boolean;
  onReview: (status: Extract<PublicationRequestStatus, "approved" | "rejected">) => void;
}) {
  const documents = asUploadedDocuments(request.submitted_documents);

  return (
    <article className="rounded-lg border border-brand-navy/10 bg-brand-navy/[0.03] p-4">
      <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PublicationStatusPill status={request.status} />
            <span className="text-xs text-muted-foreground">
              {formatDateTime(request.created_at)}
            </span>
          </div>
          <h3 className="mt-3 text-lg font-semibold text-foreground">{request.title}</h3>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{request.location ?? "Localisation à préciser"}</span>
            <span>{request.court ?? "Tribunal à préciser"}</span>
            <span>{formatPrice(request.starting_price_eur)}</span>
          </div>
          <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {request.description ?? "Description non renseignée."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {request.document_types.length ? (
              request.document_types.slice(0, 4).map((type) => (
                <span
                  key={type}
                  className="rounded-full border border-brand-navy/10 px-2.5 py-1 text-xs text-muted-foreground"
                >
                  {type}
                </span>
              ))
            ) : (
              <span className="rounded-full border border-amber-300/20 bg-warning-tint px-2.5 py-1 text-xs text-warning">
                Types de pièces à vérifier
              </span>
            )}
            {request.document_types.length > 4 ? (
              <span className="rounded-full border border-brand-navy/10 px-2.5 py-1 text-xs text-muted-foreground">
                +{request.document_types.length - 4} autre
                {request.document_types.length - 4 > 1 ? "s" : ""}
              </span>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded-full border border-brand-navy/10 px-2.5 py-1">
              {request.anonymize_documents
                ? "Anonymisation demandée"
                : "Anonymisation non demandée"}
            </span>
            {request.promotion_options.map((option) => (
              <span
                key={option}
                className="rounded-full border border-gold/20 px-2.5 py-1 text-gold-text"
              >
                {publicationPromotionLabel(option)}
              </span>
            ))}
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            Demandeur : {request.requester_email ?? "email inconnu"} · {documents.length} fichier
            {documents.length > 1 ? "s" : ""} privé{documents.length > 1 ? "s" : ""}
          </div>
          {request.published_sale_id ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-success">
              <a
                href={`/sales/${encodeURIComponent(request.published_sale_id)}`}
                className="font-semibold underline underline-offset-2"
              >
                Ouvrir la vente liée
              </a>
              {request.published_at ? (
                <span>Créée le {formatDateTime(request.published_at)}</span>
              ) : null}
              <span>Enrichissement et vérification à terminer</span>
            </div>
          ) : null}
          {documents.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {documents.slice(0, 4).map((document) => (
                <button
                  key={document.path ?? document.name}
                  type="button"
                  onClick={() => void openPublicationDocument(document)}
                  className="rounded-full border border-brand-navy/10 px-2.5 py-1 text-xs text-gold-text transition hover:border-gold"
                >
                  {document.name ?? "Ouvrir la pièce"}
                </button>
              ))}
              {documents.length > 4 ? (
                <span className="rounded-full border border-brand-navy/10 px-2.5 py-1 text-xs text-muted-foreground">
                  +{documents.length - 4} autre{documents.length - 4 > 1 ? "s" : ""}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 lg:justify-end">
          <button
            type="button"
            disabled={disabled || request.status === "approved"}
            onClick={() => onReview("approved")}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-300/20 bg-success-tint px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-success transition hover:border-emerald-200 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <CheckCircle className="h-3.5 w-3.5" />
            Valider
          </button>
          <button
            type="button"
            disabled={disabled || request.status === "rejected"}
            onClick={() => onReview("rejected")}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-300/20 bg-danger-tint px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-danger transition hover:border-red-200 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <XCircle className="h-3.5 w-3.5" />
            Refuser
          </button>
        </div>
      </div>
    </article>
  );
}

function PublicationStatusPill({ status }: { status: PublicationRequestStatus }) {
  const label =
    status === "approved" ? "Validée" : status === "rejected" ? "Refusée" : "En attente";
  const tone =
    status === "approved"
      ? "border-emerald-300/20 bg-success-tint text-success"
      : status === "rejected"
        ? "border-red-300/20 bg-danger-tint text-danger"
        : "border-amber-300/20 bg-warning-tint text-warning";

  return (
    <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs ${tone}`}>
      {label}
    </span>
  );
}

function publicationPromotionLabel(value: string): string {
  if (value === "featured") return "Mise en avant éditoriale";
  if (value === "seo") return "Préparation SEO";
  if (value === "partners") return "Relais partenaire";
  return value;
}

async function openPublicationDocument(document: UploadedPublicationDocument) {
  if (!document.path) {
    toast.error("Chemin du document introuvable.");
    return;
  }

  const { data, error } = await supabase.storage
    .from(document.bucket ?? PUBLICATION_DOCUMENT_BUCKET)
    .createSignedUrl(document.path, 60 * 5);

  if (error || !data?.signedUrl) {
    toast.error(error?.message ?? "Impossible d'ouvrir cette pièce.");
    return;
  }

  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}

function asUploadedDocuments(value: Json | null): UploadedPublicationDocument[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is UploadedPublicationDocument =>
      item !== null && typeof item === "object" && !Array.isArray(item) && "path" in item,
  );
}
