"use client";

import dynamic from "next/dynamic";
import { AdminSettingsPage } from "@/components/admin/AdminSettingsPage";
import { createFileRoute, Link } from "@/lib/router-compat";
import { useIsFetching, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import ScrollText from "lucide-react/dist/esm/icons/scroll-text.js";
import { collectionSourceResults, collectionTransportNote } from "@/lib/admin-source-collection";
import XCircle from "lucide-react/dist/esm/icons/x-circle.js";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AdminPanel,
  AdminPrimaryButton,
  AdminSectionHeading,
  AdminShell,
  type AdminSection,
} from "@/components/admin/AdminShell";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import type { Json, Tables } from "@/integrations/supabase/types";
import {
  fetchAdminDashboard,
  fetchAdminLawyerReferralRequests,
  fetchAdminPrivacyRequests,
  fetchAdminSubscriptions,
  startAdminScrollRequest,
} from "@/lib/client-api";
import {
  type AdminDashboardData,
  type AdminScrollSource,
  type AuctionRun,
} from "@/lib/admin.functions";

type RunnerMode = AdminDashboardData["runner"]["mode"];
export type AdminDashboardView = Exclude<AdminSection, "quality" | "settings">;
type PublicationRequest = Tables<"listing_publication_requests">;
type PublicationRequestStatus = PublicationRequest["status"];

type AdminPublicationQueryResult = {
  requests: PublicationRequest[];
  hasMore: boolean;
};

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

const LazyAdminPipelinePanel = dynamic(
  () => import("@/components/admin/AdminPipelinePanel").then((module) => module.AdminPipelinePanel),
  { loading: () => <AdminPanelLoading label="la supervision du pipeline" /> },
);
const LazyAdminReadinessPanel = dynamic(
  () =>
    import("@/components/admin/AdminReadinessPanel").then((module) => module.AdminReadinessPanel),
  { loading: () => <AdminPanelLoading label="le diagnostic de préparation" /> },
);
const LazyAdminLawyerReferralRequestsPanel = dynamic(
  () =>
    import("@/components/admin/AdminLawyerReferralRequestsPanel").then(
      (module) => module.AdminLawyerReferralRequestsPanel,
    ),
  { loading: () => <AdminPanelLoading label="les demandes avocat" /> },
);
const LazyAdminPrivacyRequestsPanel = dynamic(
  () =>
    import("@/components/admin/AdminPrivacyRequestsPanel").then(
      (module) => module.AdminPrivacyRequestsPanel,
    ),
  { loading: () => <AdminPanelLoading label="les demandes de conformité" /> },
);
const LazyAdminReferencedLawyersPanel = dynamic(
  () =>
    import("@/components/admin/AdminReferencedLawyersPanel").then(
      (module) => module.AdminReferencedLawyersPanel,
    ),
  { loading: () => <AdminPanelLoading label="le réseau d’avocats" /> },
);
const LazyAdminSubscriptionsPanel = dynamic(
  () =>
    import("@/components/admin/AdminSubscriptionsPanel").then(
      (module) => module.AdminSubscriptionsPanel,
    ),
  { loading: () => <AdminPanelLoading label="les abonnements" /> },
);
const LazyAdminInformationAgentWorkspace = dynamic(
  () =>
    import("@/components/admin/AdminInformationAgentWorkspace").then(
      (module) => module.AdminInformationAgentWorkspace,
    ),
  { loading: () => <AdminPanelLoading label="le template agent" /> },
);

const SOURCE_OPTIONS: Array<{ value: AdminScrollSource; label: string }> = [
  { value: "all", label: "Toutes les sources" },
  { value: "avoventes", label: "Avoventes" },
  { value: "licitor", label: "Licitor" },
  { value: "vench", label: "Vench" },
  { value: "info_encheres", label: "Info Enchères" },
  { value: "encheres_publiques", label: "Enchères-Publiques" },
  { value: "petites_affiches", label: "Petites Affiches · Supabase" },
  { value: "cessions_etat", label: "Cessions État · Supabase" },
  { value: "agrasc", label: "AGRASC" },
  { value: "encheres_immobilieres", label: "Enchères Immobilières" },
  { value: "notaires", label: "Notaires" },
];

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin — Immojudis" },
      {
        name: "description",
        content: "Dashboard administrateur Immojudis.",
      },
    ],
  }),
  component: AdminDashboardPage,
});

const VIEW_COPY: Record<
  AdminDashboardView,
  { title: string; description: string; searchPlaceholder?: string }
> = {
  overview: {
    title: "Vue d’ensemble",
    description: "Pilotez l’activité et traitez les priorités du jour.",
    searchPlaceholder: "Rechercher une exécution…",
  },
  operations: {
    title: "Opérations",
    description: "Collecte, enrichissement et suivi des traitements.",
    searchPlaceholder: "Rechercher un run…",
  },
  agent: {
    title: "Agent IA",
    description:
      "Configurez les prises de contact et contrôlez le template envoyé aux professionnels.",
  },
  publications: {
    title: "Publications",
    description: "Contrôlez les annonces professionnelles avant leur mise en ligne.",
    searchPlaceholder: "Titre, ville, tribunal…",
  },
  clients: {
    title: "Clients & abonnements",
    description: "Gérez les accès commerciaux et les plans attribués.",
  },
  lawyers: {
    title: "Avocats",
    description: "Pilotez le réseau référencé et les mises en relation.",
  },
  compliance: {
    title: "Conformité",
    description: "Suivez les demandes réglementaires et les échéances.",
  },
};

const REFRESH_QUERY_KEYS: Record<AdminDashboardView, ReadonlyArray<readonly unknown[]>> = {
  overview: [
    ["admin-dashboard"],
    ["admin-publication-requests"],
    ["admin-subscriptions"],
    ["admin-lawyer-referral-requests"],
    ["admin-privacy-requests"],
    ["admin-readiness"],
  ],
  operations: [["admin-dashboard"], ["admin-pipeline"]],
  // Refreshing this key remounts the editor from the server response and can discard a dirty draft.
  agent: [],
  publications: [["admin-publication-requests"]],
  clients: [["admin-subscriptions"]],
  lawyers: [["admin-lawyer-referral-requests"], ["admin-referenced-lawyers"]],
  compliance: [["admin-privacy-requests"], ["admin-readiness"]],
};

// Keep every console view in one client entry graph so shared navigation and
// dependencies are emitted once instead of duplicating them for configuration.
export function AdminDashboardPage({
  initialView = "overview",
}: {
  initialView?: AdminDashboardView | "settings";
}) {
  return initialView === "settings" ? (
    <AdminSettingsPage />
  ) : (
    <AdminDashboardContent initialView={initialView} />
  );
}

function AdminDashboardContent({ initialView = "overview" }: { initialView?: AdminDashboardView }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<AdminScrollSource>("all");
  const [backfillLimit, setBackfillLimit] = useState(20);
  const [searchQuery, setSearchQuery] = useState("");
  const [operationsTab, setOperationsTab] = useState<OperationsTab>("collections");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [publicationStatus, setPublicationStatus] = useState<PublicationFilter>("all");
  const [publicationLimit, setPublicationLimit] = useState(PUBLICATION_PAGE_SIZE);
  const [lawyerTab, setLawyerTab] = useState<LawyerTab>("referrals");
  const dashboardEnabled = initialView === "overview" || initialView === "operations";
  const publicationEnabled = initialView === "overview" || initialView === "publications";

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: () => fetchAdminDashboard(),
    staleTime: 30_000,
    enabled: dashboardEnabled,
    retry: 1,
  });

  const publicationRequestsQuery = useQuery<AdminPublicationQueryResult>({
    queryKey: ["admin-publication-requests", publicationLimit],
    queryFn: async (): Promise<AdminPublicationQueryResult> => {
      const { data: requests, error: requestsError } = await supabase
        .from("listing_publication_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(publicationLimit + 1);

      if (requestsError) throw requestsError;
      const rows = (requests ?? []) as PublicationRequest[];
      return {
        requests: rows.slice(0, publicationLimit),
        hasMore: rows.length > publicationLimit,
      };
    },
    staleTime: 30_000,
    enabled: publicationEnabled,
    placeholderData: (previous) => previous,
    retry: 1,
  });
  const publicationRequests = publicationRequestsQuery.data?.requests ?? [];
  const publicationRequestsLoading = publicationRequestsQuery.isLoading;
  const publicationRequestsError = publicationRequestsQuery.error;

  const subscriptionsOverviewQuery = useQuery({
    queryKey: ["admin-subscriptions"],
    queryFn: fetchAdminSubscriptions,
    staleTime: 30_000,
    enabled: initialView === "overview",
  });
  const referralsOverviewQuery = useQuery({
    queryKey: ["admin-lawyer-referral-requests"],
    queryFn: fetchAdminLawyerReferralRequests,
    staleTime: 30_000,
    enabled: initialView === "overview",
  });
  const privacyOverviewQuery = useQuery({
    queryKey: ["admin-privacy-requests"],
    queryFn: fetchAdminPrivacyRequests,
    staleTime: 30_000,
    enabled: initialView === "overview",
  });

  const activeRefreshKeys = REFRESH_QUERY_KEYS[initialView];
  const activeQueriesFetching = useIsFetching({
    type: "active",
    predicate: (query) => activeRefreshKeys.some((queryKey) => query.queryKey[0] === queryKey[0]),
  });

  const startMutation = useMutation({
    mutationFn: (requestedSource?: AdminScrollSource) =>
      startAdminScrollRequest({ data: { source: requestedSource ?? source, mode: "collect" } }),
    onSuccess: async (result) => {
      toast.success(result.message);
      await queryClient.invalidateQueries({ queryKey: ["admin-dashboard"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Impossible de lancer la collecte");
    },
  });
  const backfillMutation = useMutation({
    mutationFn: () =>
      startAdminScrollRequest({
        data: {
          source: "all",
          mode: "llm_backfill",
          limit: backfillLimit,
        },
      }),
    onSuccess: async (result) => {
      toast.success(result.message);
      await queryClient.invalidateQueries({ queryKey: ["admin-dashboard"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Impossible de lancer le backfill IA");
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async ({
      id,
      status,
    }: {
      id: string;
      status: Extract<PublicationRequestStatus, "approved" | "rejected">;
    }) => {
      const { error: reviewError } = await supabase
        .from("listing_publication_requests")
        .update({
          status,
          reviewed_at: new Date().toISOString(),
          reviewed_by: user?.id ?? null,
        })
        .eq("id", id);

      if (reviewError) throw reviewError;
    },
    onSuccess: async (_, variables) => {
      toast.success(variables.status === "approved" ? "Demande validée." : "Demande refusée.");
      await queryClient.invalidateQueries({ queryKey: ["admin-publication-requests"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Impossible de mettre à jour la demande");
    },
  });

  const latestRun = data?.runs[0] ?? null;
  const aiDescriptions = data?.stats.aiDescriptions ?? null;
  const aiBackfillRemaining = aiDescriptions?.backfillRemaining ?? null;
  const selectedRun = data?.runs.find((run) => run.id === selectedRunId) ?? data?.runs[0] ?? null;
  const copy = VIEW_COPY[initialView];
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase("fr-FR");
  const filteredRuns = (data?.runs ?? []).filter((run) =>
    normalizedSearch
      ? [run.id, run.source, run.status].some((value) =>
          String(value ?? "")
            .toLocaleLowerCase("fr-FR")
            .includes(normalizedSearch),
        )
      : true,
  );
  const filteredPublicationRequests = publicationRequests.filter((request) => {
    const matchesStatus = publicationStatus === "all" || request.status === publicationStatus;
    const matchesSearch = normalizedSearch
      ? [
          request.title,
          request.location,
          request.court,
          request.requester_email,
          request.description,
        ].some((value) =>
          String(value ?? "")
            .toLocaleLowerCase("fr-FR")
            .includes(normalizedSearch),
        )
      : true;
    return matchesStatus && matchesSearch;
  });
  const activeSubscriptions = subscriptionsOverviewQuery.data
    ? subscriptionsOverviewQuery.data.subscriptions.filter((subscription) =>
        ["active", "trialing"].includes(subscription.status),
      ).length
    : null;
  const openReferrals = referralsOverviewQuery.data
    ? referralsOverviewQuery.data.requests.filter((request) =>
        ["new", "manual_review", "sent_to_lawyer"].includes(request.status),
      ).length
    : null;
  const openPrivacyRequests = privacyOverviewQuery.data
    ? privacyOverviewQuery.data.requests.filter(
        (request) => !["completed", "rejected"].includes(request.status),
      )
    : null;
  const overduePrivacyRequests = openPrivacyRequests
    ? openPrivacyRequests.filter((request) => new Date(request.dueAt) < new Date()).length
    : null;
  const pendingPublications = publicationRequestsQuery.data
    ? publicationRequests.filter((request) => request.status === "pending").length
    : null;
  const overviewPriorities = buildOverviewPriorities({
    pendingPublications,
    openReferrals,
    openPrivacyRequests: openPrivacyRequests?.length ?? null,
    overduePrivacyRequests,
    aiBackfillRemaining,
    failedRuns: data?.stats.failedRuns ?? null,
  });
  const overviewSecondaryQueries = [
    publicationRequestsQuery,
    subscriptionsOverviewQuery,
    referralsOverviewQuery,
    privacyOverviewQuery,
  ];
  const overviewSecondaryLoading =
    initialView === "overview" && overviewSecondaryQueries.some((query) => query.isLoading);
  const overviewSecondaryErrors = overviewSecondaryQueries.flatMap((query) =>
    query.error ? [queryErrorMessage(query.error, "Données secondaires indisponibles")] : [],
  );
  const refreshCurrentView = () => {
    return queryClient.refetchQueries({
      type: "active",
      predicate: (query) => activeRefreshKeys.some((queryKey) => query.queryKey[0] === queryKey[0]),
    });
  };
  const searchable = ["overview", "operations", "publications"].includes(initialView);

  return (
    <AdminShell
      activeSection={initialView}
      title={copy.title}
      description={copy.description}
      adminEmail={data?.adminEmail ?? user?.email}
      searchValue={searchQuery}
      searchPlaceholder={copy.searchPlaceholder}
      onSearchChange={searchable ? setSearchQuery : undefined}
      onRefresh={activeRefreshKeys.length ? refreshCurrentView : undefined}
      isRefreshing={activeQueriesFetching > 0}
      primaryAction={
        initialView === "overview" ? (
          <AdminPrimaryButton
            disabled={startMutation.isPending}
            onClick={() => startMutation.mutate(undefined)}
          >
            {startMutation.isPending ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <Play className="size-4" />
            )}
            Lancer une collecte
          </AdminPrimaryButton>
        ) : undefined
      }
    >
      {error ? (
        <AdminQueryErrorNotice
          className="mb-4"
          error={error}
          fallback="Erreur de chargement admin"
          hasData={Boolean(data)}
          isRetrying={activeQueriesFetching > 0}
          onRetry={() => void refreshCurrentView()}
        />
      ) : null}

      {initialView === "overview" ? (
        <AdminOverview
          data={data}
          isLoading={isLoading}
          error={error}
          latestRun={latestRun}
          activeSubscriptions={activeSubscriptions}
          activeSubscriptionsLoading={subscriptionsOverviewQuery.isLoading}
          activeSubscriptionsError={subscriptionsOverviewQuery.error}
          aiBackfillRemaining={aiBackfillRemaining}
          priorities={overviewPriorities}
          prioritiesLoading={overviewSecondaryLoading}
          priorityErrors={overviewSecondaryErrors}
          filteredRuns={filteredRuns}
          onRetry={() => void refreshCurrentView()}
        />
      ) : null}

      {initialView === "operations" ? (
        <>
          <LazyAdminPipelinePanel />
          <AdminOperations
            data={data}
            isLoading={isLoading}
            source={source}
            setSource={setSource}
            selectedRun={selectedRun}
            onSelectRun={setSelectedRunId}
            runs={filteredRuns}
            activeTab={operationsTab}
            onTabChange={setOperationsTab}
            backfillLimit={backfillLimit}
            setBackfillLimit={setBackfillLimit}
            startMutationPending={startMutation.isPending}
            onStart={(requestedSource) => startMutation.mutate(requestedSource)}
            backfillPending={backfillMutation.isPending}
            onBackfill={() => backfillMutation.mutate()}
          />
        </>
      ) : null}

      {initialView === "agent" ? <LazyAdminInformationAgentWorkspace /> : null}

      {initialView === "publications" ? (
        <AdminPublications
          requests={filteredPublicationRequests}
          totalRequests={publicationRequestsQuery.data ? publicationRequests.length : null}
          pendingCount={pendingPublications}
          loading={publicationRequestsLoading}
          error={publicationRequestsError}
          fetching={publicationRequestsQuery.isFetching}
          hasMore={publicationRequestsQuery.data?.hasMore ?? false}
          limit={publicationLimit}
          onLoadMore={() => setPublicationLimit((limit) => limit + PUBLICATION_PAGE_SIZE)}
          onRetry={() => void publicationRequestsQuery.refetch()}
          filter={publicationStatus}
          onFilterChange={setPublicationStatus}
          reviewPending={reviewMutation.isPending}
          onReview={(id, status) => reviewMutation.mutate({ id, status })}
        />
      ) : null}

      {initialView === "clients" ? <LazyAdminSubscriptionsPanel /> : null}

      {initialView === "lawyers" ? (
        <AdminLawyers activeTab={lawyerTab} onTabChange={setLawyerTab} />
      ) : null}

      {initialView === "compliance" ? (
        <div className="space-y-6">
          <LazyAdminPrivacyRequestsPanel />
          <LazyAdminReadinessPanel />
        </div>
      ) : null}
    </AdminShell>
  );
}

type OperationsTab = "collections" | "enrichment" | "documents" | "alerts";
type PublicationFilter = "all" | PublicationRequestStatus;
type LawyerTab = "referrals" | "directory";

type OverviewPriority = {
  label: string;
  context: string;
  urgency: "medium" | "high";
  href: string;
};

function buildOverviewPriorities({
  pendingPublications,
  openReferrals,
  openPrivacyRequests,
  overduePrivacyRequests,
  aiBackfillRemaining,
  failedRuns,
}: {
  pendingPublications: number | null;
  openReferrals: number | null;
  openPrivacyRequests: number | null;
  overduePrivacyRequests: number | null;
  aiBackfillRemaining: number | null;
  failedRuns: number | null;
}): OverviewPriority[] {
  const priorities: OverviewPriority[] = [];
  if (pendingPublications != null && pendingPublications > 0) {
    priorities.push({
      label: `${pendingPublications} demande${pendingPublications > 1 ? "s" : ""} de publication`,
      context: "Annonces professionnelles en attente de validation",
      urgency: "medium",
      href: "/admin/publications",
    });
  }
  if (openReferrals != null && openReferrals > 0) {
    priorities.push({
      label: `${openReferrals} mise${openReferrals > 1 ? "s" : ""} en relation avocat`,
      context: "Demandes ouvertes à attribuer ou à suivre",
      urgency: "medium",
      href: "/admin/lawyers",
    });
  }
  if (openPrivacyRequests != null && openPrivacyRequests > 0) {
    priorities.push({
      label: `${openPrivacyRequests} demande${openPrivacyRequests > 1 ? "s" : ""} de conformité`,
      context: overduePrivacyRequests
        ? `${overduePrivacyRequests} échéance${overduePrivacyRequests > 1 ? "s" : ""} dépassée${overduePrivacyRequests > 1 ? "s" : ""}`
        : "Aucune échéance dépassée",
      urgency: overduePrivacyRequests ? "high" : "medium",
      href: "/admin/compliance",
    });
  }
  if (failedRuns != null && failedRuns > 0) {
    priorities.push({
      label: `${failedRuns} run${failedRuns > 1 ? "s" : ""} en échec`,
      context: "Une vérification des erreurs est nécessaire",
      urgency: "high",
      href: "/admin/operations",
    });
  }
  if (aiBackfillRemaining != null && aiBackfillRemaining > 0) {
    priorities.push({
      label: `${aiBackfillRemaining} synthèse${aiBackfillRemaining > 1 ? "s" : ""} IA à traiter`,
      context: "Annonces actives à aligner sur la version attendue",
      urgency: "medium",
      href: "/admin/operations",
    });
  }
  return priorities.slice(0, 5);
}

function queryErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function AdminPanelLoading({ label }: { label: string }) {
  return (
    <AdminPanel className="flex min-h-36 items-center justify-center p-6 text-sm text-[#132238]/60">
      <span role="status">Chargement de {label}…</span>
    </AdminPanel>
  );
}

function AdminQueryErrorNotice({
  className = "",
  error,
  fallback,
  hasData,
  isRetrying,
  onRetry,
}: {
  className?: string;
  error: unknown;
  fallback: string;
  hasData: boolean;
  isRetrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      className={`rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 ${className}`}
      role="alert"
    >
      <div>
        {hasData
          ? "Actualisation impossible. Les dernières données reçues restent affichées."
          : queryErrorMessage(error, fallback)}
      </div>
      <button
        type="button"
        className="admin-button-secondary mt-3"
        disabled={isRetrying}
        onClick={onRetry}
      >
        {isRetrying ? "Nouvelle tentative…" : "Réessayer"}
      </button>
    </div>
  );
}

function AdminOverview({
  data,
  isLoading,
  error,
  latestRun,
  activeSubscriptions,
  activeSubscriptionsLoading,
  activeSubscriptionsError,
  aiBackfillRemaining,
  priorities,
  prioritiesLoading,
  priorityErrors,
  filteredRuns,
  onRetry,
}: {
  data?: AdminDashboardData;
  isLoading: boolean;
  error: unknown;
  latestRun: AuctionRun | null;
  activeSubscriptions: number | null;
  activeSubscriptionsLoading: boolean;
  activeSubscriptionsError: unknown;
  aiBackfillRemaining: number | null;
  priorities: OverviewPriority[];
  prioritiesLoading: boolean;
  priorityErrors: string[];
  filteredRuns: AuctionRun[];
  onRetry: () => void;
}) {
  const failedRuns = data?.stats.failedRuns ?? null;
  const healthState =
    isLoading && !data ? "loading" : error && !data ? "error" : error && data ? "stale" : "ready";
  const healthy = healthState === "ready" && !error && failedRuns === 0;
  const aiStats = data?.stats.aiDescriptions;
  const completion = aiStats?.activeOrUpcoming
    ? Math.round((aiStats.ready / aiStats.activeOrUpcoming) * 100)
    : null;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[0.78fr_1.22fr]">
        <AdminPanel className="flex min-h-44 items-center gap-5 p-6">
          <span
            className={`grid size-14 shrink-0 place-items-center rounded-full ${
              healthState === "loading"
                ? "bg-slate-300 text-white"
                : healthy
                  ? "bg-emerald-600 text-white"
                  : "bg-amber-500 text-white"
            }`}
          >
            {healthState === "loading" ? (
              <RefreshCw className="size-7 animate-spin" />
            ) : healthy ? (
              <CheckCircle className="size-8" />
            ) : (
              <AlertTriangle className="size-7" />
            )}
          </span>
          <div>
            <h2 className="text-xl font-semibold text-[#132238]">
              {healthState === "loading"
                ? "Vérification de la santé…"
                : healthState === "error"
                  ? "État de santé indisponible"
                  : healthState === "stale"
                    ? "Données de santé potentiellement obsolètes"
                    : healthy
                      ? "Aucun échec récent détecté"
                      : "Une intervention est requise"}
            </h2>
            <p className="mt-2 text-sm text-[#132238]/60">
              {data?.checkedAt
                ? `${error ? "Dernière vérification" : "Vérifié"} ${formatRelativeTime(data.checkedAt)} · santé calculée sur les exécutions récentes`
                : "Les résultats apparaîtront après la vérification du dashboard."}
            </p>
            {healthState === "error" ? (
              <button type="button" className="admin-button-secondary mt-3" onClick={onRetry}>
                Réessayer
              </button>
            ) : null}
            <Link
              to="/admin/settings"
              className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[#a96126]"
            >
              Configuration rapide <ChevronRight className="size-4" />
            </Link>
          </div>
        </AdminPanel>

        <AdminPanel className="p-5">
          <AdminSectionHeading
            title="Activité du pipeline"
            description="Volumes intégrés lors des dernières exécutions"
          />
          {isLoading && !data ? (
            <p className="mt-3 text-sm text-[#132238]/58" role="status">
              Chargement de l’activité…
            </p>
          ) : data ? (
            <PipelineActivityChart runs={data.runs} />
          ) : (
            <p className="mt-3 text-sm text-red-700">Activité indisponible.</p>
          )}
        </AdminPanel>
      </div>

      <AdminPanel className="grid divide-y divide-[#132238]/10 sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4">
        <OverviewMetric
          icon={<ScrollText />}
          value={isLoading && !data ? "…" : data ? formatInteger(data.stats.sales) : "—"}
          label="Annonces"
        />
        <OverviewMetric
          icon={<CheckCircle />}
          value={isLoading && !data ? "…" : completion == null ? "—" : `${completion}%`}
          label="Synthèses IA prêtes"
          tone="green"
        />
        <OverviewMetric
          icon={<Bot />}
          value={
            isLoading && !data
              ? "…"
              : aiBackfillRemaining == null
                ? "—"
                : formatInteger(aiBackfillRemaining)
          }
          label="Synthèses IA à traiter"
          tone="copper"
        />
        <OverviewMetric
          icon={<Activity />}
          value={
            activeSubscriptionsLoading && activeSubscriptions == null
              ? "…"
              : activeSubscriptions == null
                ? "—"
                : formatInteger(activeSubscriptions)
          }
          label="Accès actifs"
        />
      </AdminPanel>

      {activeSubscriptionsError ? (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
          role="status"
        >
          Accès actifs indisponibles pour le moment. Les autres indicateurs restent consultables.
        </div>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[1.55fr_0.75fr]">
        <AdminPanel className="overflow-hidden">
          <div className="border-b border-[#132238]/10 px-5 py-4">
            <AdminSectionHeading
              title="À traiter aujourd’hui"
              description="Les actions qui demandent une décision administrateur"
            />
          </div>
          {prioritiesLoading && !priorities.length ? (
            <div
              className="flex min-h-44 items-center justify-center p-6 text-center text-sm text-[#132238]/60"
              role="status"
            >
              Chargement des priorités…
            </div>
          ) : priorityErrors.length && !priorities.length ? (
            <div className="p-6 text-sm text-amber-800" role="status">
              <p>Les priorités sont partiellement indisponibles.</p>
              <button type="button" className="admin-button-secondary mt-3" onClick={onRetry}>
                Réessayer
              </button>
            </div>
          ) : priorities.length ? (
            <>
              {priorityErrors.length ? (
                <div
                  className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800"
                  role="status"
                >
                  Certaines priorités n’ont pas pu être vérifiées. Les éléments affichés peuvent
                  être incomplets.
                </div>
              ) : null}
              <div className="divide-y divide-[#132238]/10">
                {priorities.map((priority) => (
                  <div
                    key={`${priority.href}-${priority.label}`}
                    className="grid gap-3 px-5 py-4 md:grid-cols-[1.1fr_1.2fr_auto_auto] md:items-center"
                  >
                    <strong className="text-sm text-[#132238]">{priority.label}</strong>
                    <span className="text-sm text-[#132238]/62">{priority.context}</span>
                    <span
                      className={`w-fit rounded px-2 py-1 text-xs font-medium ${
                        priority.urgency === "high"
                          ? "bg-red-50 text-red-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {priority.urgency === "high" ? "Élevée" : "Moyenne"}
                    </span>
                    <Link to={priority.href} className="admin-button-secondary min-h-9 px-3 py-1.5">
                      Ouvrir
                    </Link>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex min-h-44 items-center justify-center p-6 text-center text-sm text-[#132238]/60">
              Aucune action prioritaire pour le moment.
            </div>
          )}
        </AdminPanel>

        <AdminPanel className="p-5">
          <AdminSectionHeading title="Dernière collecte" />
          {latestRun ? (
            <LatestRun run={latestRun} />
          ) : (
            <EmptyState label={data ? "Aucun run trouvé" : "Données indisponibles"} />
          )}
          <Link
            to="/admin/operations"
            className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-[#a96126]"
          >
            Voir le détail <ChevronRight className="size-4" />
          </Link>
        </AdminPanel>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1.55fr_0.75fr]">
        <AdminPanel className="overflow-hidden">
          <div className="border-b border-[#132238]/10 px-5 py-4">
            <AdminSectionHeading title="Activité récente" />
          </div>
          <RecentRunsTable
            runs={filteredRuns.slice(0, 5)}
            isLoading={isLoading}
            hasData={Boolean(data)}
          />
        </AdminPanel>
        <AdminPanel className="p-5">
          <AdminSectionHeading title="Santé du pipeline" />
          <div className="mt-4 divide-y divide-[#132238]/10">
            <PipelineStat label="Runs en file" value={data?.stats.queuedRuns ?? null} />
            <PipelineStat label="Runs actifs" value={data?.stats.runningRuns ?? null} />
            <PipelineStat label="Échecs récents" value={failedRuns} danger={Boolean(failedRuns)} />
          </div>
          <Link
            to="/admin/operations"
            className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-[#a96126]"
          >
            Voir le monitoring détaillé <ChevronRight className="size-4" />
          </Link>
        </AdminPanel>
      </div>

      <LazyAdminReadinessPanel />
    </div>
  );
}

function AdminOperations({
  data,
  isLoading,
  source,
  setSource,
  selectedRun,
  onSelectRun,
  runs,
  activeTab,
  onTabChange,
  backfillLimit,
  setBackfillLimit,
  startMutationPending,
  onStart,
  backfillPending,
  onBackfill,
}: {
  data?: AdminDashboardData;
  isLoading: boolean;
  source: AdminScrollSource;
  setSource: (value: AdminScrollSource) => void;
  selectedRun: AuctionRun | null;
  onSelectRun: (id: string) => void;
  runs: AuctionRun[];
  activeTab: OperationsTab;
  onTabChange: (tab: OperationsTab) => void;
  backfillLimit: number;
  setBackfillLimit: (value: number) => void;
  startMutationPending: boolean;
  onStart: (source?: AdminScrollSource) => void;
  backfillPending: boolean;
  onBackfill: () => void;
}) {
  const aiDescriptions = data?.stats.aiDescriptions;
  const remaining = aiDescriptions?.backfillRemaining ?? 0;
  const progress = aiDescriptions?.activeOrUpcoming
    ? Math.round((aiDescriptions.ready / aiDescriptions.activeOrUpcoming) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 xl:grid-cols-[1fr_25rem]">
        <AdminPanel className="p-5">
          <AdminSectionHeading title="Lancer une collecte" />
          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto_auto] lg:items-end">
            <label className="grid gap-2 text-sm font-medium text-[#132238]">
              Source
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as AdminScrollSource)}
                className="h-11 rounded-lg border border-[#132238]/18 bg-white px-3 text-sm outline-none transition focus:border-[#c98d45] focus:ring-2 focus:ring-[#c98d45]/15"
              >
                {SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex h-11 items-center gap-3 text-sm text-[#132238]/75">
              <span className="grid size-5 place-items-center rounded bg-[#b96f2d] text-white">
                <CheckCircle className="size-3.5" />
              </span>
              Synthèse IA automatique
            </div>
            <AdminPrimaryButton disabled={startMutationPending} onClick={() => onStart()}>
              {startMutationPending ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Lancer
            </AdminPrimaryButton>
          </div>
          {collectionTransportNote(source) ? (
            <p className="mt-3 text-sm text-[#132238]/70" role="status">
              {collectionTransportNote(source)}
            </p>
          ) : null}
        </AdminPanel>

        <AdminPanel className="flex items-center gap-4 p-5">
          <span className="grid size-11 place-items-center rounded-full bg-[#132238] text-white">
            <Database className="size-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2 font-semibold text-[#132238]">
              {runnerModeLabel(data?.runner.mode ?? "queue_worker")}
              <span className="text-emerald-700">· Actif</span>
            </div>
            <p className="mt-1 text-sm text-[#132238]/58">
              Vérifié {data?.checkedAt ? formatRelativeTime(data.checkedAt) : "à l’instant"}
            </p>
          </div>
        </AdminPanel>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[#132238]/14">
        {(
          [
            ["collections", "Collectes"],
            ["enrichment", "Enrichissement IA"],
            ["documents", "Documents"],
            ["alerts", "Alertes"],
          ] as Array<[OperationsTab, string]>
        ).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => onTabChange(tab)}
            className={`shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition ${
              activeTab === tab
                ? "border-[#b96f2d] text-[#a96126]"
                : "border-transparent text-[#132238]/58 hover:text-[#132238]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "collections" ? (
        <>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
            <AdminPanel className="overflow-hidden">
              <div className="border-b border-[#132238]/10 px-5 py-4">
                <AdminSectionHeading title="Exécutions" />
              </div>
              <OperationsRunTable
                runs={runs}
                isLoading={isLoading}
                selectedRunId={selectedRun?.id ?? null}
                onSelectRun={onSelectRun}
              />
            </AdminPanel>
            <RunDetails
              run={selectedRun}
              onRestart={(runSource) => onStart(asAdminScrollSource(runSource))}
              restartPending={startMutationPending}
            />
          </div>
          <AiBackfillPanel
            aiDescriptions={aiDescriptions}
            remaining={remaining}
            progress={progress}
            backfillLimit={backfillLimit}
            setBackfillLimit={setBackfillLimit}
            pending={backfillPending}
            onBackfill={onBackfill}
          />
          {(data?.stats.failedRuns ?? 0) > 0 ? (
            <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
              <AlertTriangle className="size-5 shrink-0" />
              {data?.stats.failedRuns} run{(data?.stats.failedRuns ?? 0) > 1 ? "s" : ""} en échec
              nécessite{(data?.stats.failedRuns ?? 0) > 1 ? "nt" : ""} une vérification.
            </div>
          ) : null}
        </>
      ) : null}

      {activeTab === "enrichment" ? (
        <AiBackfillPanel
          aiDescriptions={aiDescriptions}
          remaining={remaining}
          progress={progress}
          backfillLimit={backfillLimit}
          setBackfillLimit={setBackfillLimit}
          pending={backfillPending}
          onBackfill={onBackfill}
          expanded
        />
      ) : null}

      {activeTab === "documents" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <AdminPanel className="p-6">
            <OverviewMetric
              icon={<FileSearch />}
              value={formatInteger(data?.stats.documents ?? 0)}
              label="Documents indexés"
            />
          </AdminPanel>
          <AdminPanel className="p-6">
            <OverviewMetric
              icon={<Activity />}
              value={formatInteger(data?.stats.extractions ?? 0)}
              label="Extractions structurées"
            />
          </AdminPanel>
        </div>
      ) : null}

      {activeTab === "alerts" ? (
        <AdminPanel className="p-5">
          <AdminSectionHeading
            title="Alertes opérationnelles"
            description="Signaux calculés à partir des exécutions récentes"
          />
          <div className="mt-5 divide-y divide-[#132238]/10">
            <PipelineStat label="Runs en file" value={data?.stats.queuedRuns ?? null} />
            <PipelineStat label="Runs actifs" value={data?.stats.runningRuns ?? null} />
            <PipelineStat
              label="Runs échoués récents"
              value={data?.stats.failedRuns ?? null}
              danger={(data?.stats.failedRuns ?? 0) > 0}
            />
            <PipelineStat
              label="Synthèses IA à traiter"
              value={data?.stats.aiDescriptions.backfillRemaining ?? null}
            />
          </div>
        </AdminPanel>
      ) : null}
    </div>
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
  limit,
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
  limit: number;
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
      <div className="border-b border-[#132238]/10 p-5">
        <AdminSectionHeading
          title="File de validation"
          description={
            pendingCount == null || totalRequests == null
              ? "Nombre de demandes indisponible"
              : `${pendingCount} demande${pendingCount > 1 ? "s" : ""} en attente sur ${totalRequests}`
          }
          action={
            <div className="flex flex-wrap gap-1 rounded-lg bg-[#132238]/[0.04] p-1">
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
                      ? "bg-white text-[#132238] shadow-sm"
                      : "text-[#132238]/55 hover:text-[#132238]"
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
          <div className="py-16 text-center text-sm text-[#132238]/58">
            {error
              ? "Les demandes sont indisponibles pour le moment."
              : "Aucune demande ne correspond aux filtres."}
          </div>
        )}
        {hasMore && !loading && !error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#132238]/10 pt-4">
            <span className="text-xs text-[#132238]/58">
              {requests.length} demandes affichées · limite actuelle {limit}
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

function AdminLawyers({
  activeTab,
  onTabChange,
}: {
  activeTab: LawyerTab;
  onTabChange: (tab: LawyerTab) => void;
}) {
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-[#132238]/14">
        <button
          type="button"
          onClick={() => onTabChange("referrals")}
          className={`border-b-2 px-4 py-3 text-sm font-medium ${
            activeTab === "referrals"
              ? "border-[#b96f2d] text-[#a96126]"
              : "border-transparent text-[#132238]/58"
          }`}
        >
          Mises en relation
        </button>
        <button
          type="button"
          onClick={() => onTabChange("directory")}
          className={`border-b-2 px-4 py-3 text-sm font-medium ${
            activeTab === "directory"
              ? "border-[#b96f2d] text-[#a96126]"
              : "border-transparent text-[#132238]/58"
          }`}
        >
          Réseau référencé
        </button>
      </div>
      {activeTab === "referrals" ? (
        <LazyAdminLawyerReferralRequestsPanel />
      ) : (
        <LazyAdminReferencedLawyersPanel />
      )}
    </div>
  );
}

function PipelineActivityChart({ runs }: { runs: AuctionRun[] }) {
  const values = runs
    .slice(0, 10)
    .reverse()
    .map((run) => Number(summaryNumber(run, "upserted")) || 0);
  const chartValues = values.length > 1 ? values : [0, values[0] ?? 0];
  const width = 640;
  const height = 132;
  const padding = 12;
  const maxValue = Math.max(...chartValues, 1);
  const points = chartValues
    .map((value, index) => {
      const x = padding + (index / (chartValues.length - 1)) * (width - padding * 2);
      const y = height - padding - (value / maxValue) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");
  const areaPoints = `${padding},${height - padding} ${points} ${width - padding},${height - padding}`;

  return (
    <div className="mt-3 h-32 w-full" aria-label="Activité des dernières exécutions">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-full w-full overflow-visible"
        role="img"
        aria-label="Volumes intégrés par exécution"
      >
        <defs>
          <linearGradient id="admin-chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#2b79d3" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#2b79d3" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={padding}
            x2={width - padding}
            y1={height * ratio}
            y2={height * ratio}
            stroke="rgb(19 34 56 / 9%)"
            strokeWidth="1"
          />
        ))}
        <polygon points={areaPoints} fill="url(#admin-chart-fill)" />
        <polyline
          points={points}
          fill="none"
          stroke="#2878d2"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2.5"
        />
        {chartValues.map((value, index) => {
          const [x, y] = points.split(" ")[index].split(",");
          return (
            <circle
              key={`${index}-${value}`}
              cx={x}
              cy={y}
              r="3"
              fill="#ffffff"
              stroke="#2878d2"
              strokeWidth="2"
            />
          );
        })}
      </svg>
    </div>
  );
}

function OverviewMetric({
  icon,
  value,
  label,
  tone = "blue",
}: {
  icon: React.ReactElement;
  value: string;
  label: string;
  tone?: "blue" | "green" | "copper";
}) {
  const iconTone =
    tone === "green" ? "text-emerald-700" : tone === "copper" ? "text-[#b96f2d]" : "text-[#1f67b6]";
  return (
    <div className="flex min-h-24 items-center gap-4 px-5 py-4">
      <span className={`${iconTone} [&>svg]:size-7`}>{icon}</span>
      <span>
        <strong className="block text-2xl font-semibold tabular-nums text-[#132238]">
          {value}
        </strong>
        <span className="mt-0.5 block text-sm text-[#132238]/62">{label}</span>
      </span>
    </div>
  );
}

function RecentRunsTable({
  runs,
  isLoading,
  hasData,
}: {
  runs: AuctionRun[];
  isLoading: boolean;
  hasData: boolean;
}) {
  if (isLoading && !hasData) {
    return <div className="p-5 text-sm text-[#132238]/58">Chargement de l’activité…</div>;
  }
  if (!hasData) {
    return <div className="p-5 text-sm text-red-700">Activité indisponible.</div>;
  }
  if (!runs.length) {
    return <div className="p-5 text-sm text-[#132238]/58">Aucune exécution trouvée.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[42rem]">
        <div className="grid grid-cols-[1.4fr_0.9fr_0.75fr_1fr] gap-4 border-b border-[#132238]/10 px-5 py-3 text-xs font-semibold text-[#132238]/55">
          <span>Événement</span>
          <span>Domaine</span>
          <span>Statut</span>
          <span>Date</span>
        </div>
        <div className="divide-y divide-[#132238]/10">
          {runs.map((run) => (
            <div
              key={run.id}
              className="grid grid-cols-[1.4fr_0.9fr_0.75fr_1fr] gap-4 px-5 py-3 text-sm"
            >
              <span className="font-medium text-[#132238]">
                Collecte {run.source ?? "toutes sources"}
              </span>
              <span className="text-[#132238]/62">Opérations</span>
              <StatusPill status={run.status} />
              <span className="text-[#132238]/62">
                {run.startedAt ? formatDateTime(run.startedAt) : "—"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PipelineStat({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: number | null;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-4 text-sm">
      <span className="text-[#132238]/68">{label}</span>
      <strong className={`text-xl tabular-nums ${danger ? "text-red-600" : "text-[#1f67b6]"}`}>
        {value == null ? "—" : formatInteger(value)}
      </strong>
    </div>
  );
}

function OperationsRunTable({
  runs,
  isLoading,
  selectedRunId,
  onSelectRun,
}: {
  runs: AuctionRun[];
  isLoading: boolean;
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
}) {
  if (isLoading) {
    return <div className="p-5 text-sm text-[#132238]/58">Chargement des exécutions…</div>;
  }
  if (!runs.length) {
    return <div className="p-5 text-sm text-[#132238]/58">Aucune exécution trouvée.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[58rem]">
        <div className="grid grid-cols-[1fr_1fr_0.85fr_1.25fr_0.8fr_0.75fr_0.75fr_0.45fr] gap-3 border-b border-[#132238]/10 px-5 py-3 text-xs font-semibold text-[#132238]/55">
          <span>Run</span>
          <span>Source</span>
          <span>Statut</span>
          <span>Début</span>
          <span>Durée</span>
          <span>Collectées</span>
          <span>Intégrées</span>
          <span>Err.</span>
        </div>
        <div className="divide-y divide-[#132238]/10">
          {runs.map((run) => {
            const selected = run.id === selectedRunId;
            return (
              <button
                key={run.id}
                type="button"
                onClick={() => onSelectRun(run.id)}
                className={`grid w-full grid-cols-[1fr_1fr_0.85fr_1.25fr_0.8fr_0.75fr_0.75fr_0.45fr] gap-3 px-5 py-3 text-left text-sm transition hover:bg-[#132238]/[0.025] ${
                  selected ? "border-l-2 border-[#b96f2d] bg-[#fff7eb] pl-[1.125rem]" : ""
                }`}
              >
                <span className="font-mono text-xs font-semibold text-[#132238]">
                  #{shortId(run.id).toUpperCase()}
                </span>
                <span className="truncate text-[#132238]/72">{run.source ?? "—"}</span>
                <StatusPill status={run.status} />
                <span className="text-[#132238]/65">
                  {run.startedAt ? formatDateTime(run.startedAt) : "—"}
                </span>
                <span className="text-[#132238]/65">{runDuration(run)}</span>
                <span className="tabular-nums text-[#132238]">
                  {summaryNumber(run, "collected")}
                </span>
                <span className="tabular-nums text-[#132238]">
                  {summaryNumber(run, "upserted")}
                </span>
                <span className={errorCount(run.errors) ? "text-red-600" : "text-[#132238]/65"}>
                  {errorCount(run.errors)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RunDetails({
  run,
  onRestart,
  restartPending,
}: {
  run: AuctionRun | null;
  onRestart: (source: string | null) => void;
  restartPending: boolean;
}) {
  const [showLogs, setShowLogs] = useState(false);
  if (!run) {
    return (
      <AdminPanel className="flex min-h-96 items-center justify-center p-6 text-sm text-[#132238]/58">
        Sélectionnez une exécution pour voir son détail.
      </AdminPanel>
    );
  }
  const stages = [
    ["Collecte", summaryNumber(run, "collected")],
    ["Déduplication", summaryNumber(run, "deduplicated")],
    ["Écriture Supabase", summaryNumber(run, "upserted")],
  ] as const;
  return (
    <AdminPanel className="p-5">
      <AdminSectionHeading title="Exécution sélectionnée" />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <strong className="font-mono text-xl text-[#132238]">
          #{shortId(run.id).toUpperCase()}
        </strong>
        <StatusPill status={run.status} />
      </div>
      <dl className="mt-5 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-3 text-sm">
        <dt className="text-[#132238]/55">Source</dt>
        <dd className="text-[#132238]">{run.source ?? "—"}</dd>
        <dt className="text-[#132238]/55">Début</dt>
        <dd className="text-[#132238]">{run.startedAt ? formatDateTime(run.startedAt) : "—"}</dd>
        <dt className="text-[#132238]/55">Durée</dt>
        <dd className="text-[#132238]">{runDuration(run)}</dd>
      </dl>
      <div className="mt-5 grid grid-cols-3 divide-x divide-[#132238]/10 border-y border-[#132238]/10 py-4 text-center">
        <RunSummaryNumber value={summaryNumber(run, "collected")} label="collectées" />
        <RunSummaryNumber value={summaryNumber(run, "deduplicated")} label="dédupliquées" />
        <RunSummaryNumber value={summaryNumber(run, "upserted")} label="intégrées" />
      </div>
      <div className="mt-5 space-y-4">
        {stages.map(([label, value], index) => (
          <div key={label} className="relative flex items-center gap-3 text-sm">
            {index < stages.length - 1 ? (
              <span
                className={`absolute left-[0.47rem] top-5 h-5 w-px ${
                  runStageState(run, index) === "complete" ? "bg-emerald-300" : "bg-[#132238]/15"
                }`}
              />
            ) : null}
            <RunStageIcon state={runStageState(run, index)} />
            <span className="flex-1 text-[#132238]">{label}</span>
            <span className="tabular-nums text-[#132238]/58">
              {value} · {runStageLabel(runStageState(run, index))}
            </span>
          </div>
        ))}
        {errorCount(run.errors) > 0 ? (
          <div className="flex items-center gap-3 text-sm text-amber-700">
            <AlertTriangle className="size-4" />
            {errorCount(run.errors)} avertissement{errorCount(run.errors) > 1 ? "s" : ""}
          </div>
        ) : null}
      </div>
      {collectionSourceResults(run.summary).length > 0 ? (
        <div className="mt-5 space-y-2 text-sm" aria-label="Résultats par source">
          <h3 className="font-semibold text-[#132238]">Résultats par source</h3>
          {collectionSourceResults(run.summary).map((result) => (
            <div
              key={result.source}
              className="flex flex-wrap justify-between gap-2 border-t border-[#132238]/10 pt-2"
            >
              <span>
                {SOURCE_OPTIONS.find((option) => option.value === result.source)?.label.replace(
                  " · Supabase",
                  "",
                ) ?? result.source}
              </span>
              <span className={result.failed ? "text-amber-700" : "text-[#132238]/65"}>
                {result.transport} · {result.listings ?? "—"} annonce(s) extraite(s)
                {result.failed ? " · Erreur signalée" : ""}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="mt-6 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => setShowLogs((current) => !current)}
          className="admin-button-secondary"
          aria-expanded={showLogs}
        >
          {showLogs ? "Masquer les détails" : "Afficher les détails"}
        </button>
        <AdminPrimaryButton disabled={restartPending} onClick={() => onRestart(run.source)}>
          {restartPending ? <RefreshCw className="size-4 animate-spin" /> : null}
          Relancer
        </AdminPrimaryButton>
      </div>
      {showLogs ? (
        <div className="mt-4 grid gap-4 rounded-lg border border-[#132238]/10 bg-[#132238]/[0.025] p-4 text-xs">
          <div>
            <h3 className="font-semibold text-[#132238]">Résumé JSON</h3>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[#132238]/72">
              {JSON.stringify(run.summary, null, 2)}
            </pre>
          </div>
          <div>
            <h3 className="font-semibold text-[#132238]">Erreurs JSON</h3>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[#132238]/72">
              {JSON.stringify(run.errors, null, 2)}
            </pre>
          </div>
        </div>
      ) : null}
    </AdminPanel>
  );
}

type RunStageState = "complete" | "failed" | "running" | "pending" | "unknown";

function runStageState(run: AuctionRun, index: number): RunStageState {
  const summaryKeys = ["collected", "deduplicated", "upserted"];
  const key = summaryKeys[index];
  const hasValue = key ? typeof run.summary[key] === "number" : false;

  if (run.status === "failed") {
    const failedStage = failedRunStageIndex(run);
    if (failedStage == null) return "unknown";
    if (index === failedStage) return "failed";
    return index < failedStage && hasValue ? "complete" : "unknown";
  }
  if (run.status === "succeeded") return hasValue ? "complete" : "unknown";
  if (run.status === "running") return hasValue ? "complete" : index === 0 ? "running" : "pending";
  if (run.status === "queued") return "pending";
  return hasValue ? "complete" : "unknown";
}

function failedRunStageIndex(run: AuctionRun): number | null {
  for (const key of Object.keys(run.errors)) {
    const normalized = key.toLocaleLowerCase("fr-FR");
    if (/(collect|source|scrap)/.test(normalized)) return 0;
    if (/(dedup|duplicat)/.test(normalized)) return 1;
    if (/(upsert|write|supabase|persist)/.test(normalized)) return 2;
  }
  return null;
}

function runStageLabel(state: RunStageState): string {
  if (state === "complete") return "terminée";
  if (state === "failed") return "en échec";
  if (state === "running") return "en cours";
  if (state === "pending") return "en attente";
  return "non déterminée";
}

function RunStageIcon({ state }: { state: RunStageState }) {
  if (state === "complete") {
    return <CheckCircle className="relative z-10 size-4 shrink-0 text-emerald-600" />;
  }
  if (state === "failed") {
    return <XCircle className="relative z-10 size-4 shrink-0 text-red-600" />;
  }
  if (state === "running") {
    return <RefreshCw className="relative z-10 size-4 shrink-0 animate-spin text-sky-600" />;
  }
  return <AlertTriangle className="relative z-10 size-4 shrink-0 text-amber-600" />;
}

function RunSummaryNumber({ value, label }: { value: string; label: string }) {
  return (
    <span className="px-2">
      <strong className="block text-xl tabular-nums text-[#132238]">{value}</strong>
      <span className="mt-1 block text-xs text-[#132238]/55">{label}</span>
    </span>
  );
}

function AiBackfillPanel({
  aiDescriptions,
  remaining,
  progress,
  backfillLimit,
  setBackfillLimit,
  pending,
  onBackfill,
  expanded = false,
}: {
  aiDescriptions?: AdminDashboardData["stats"]["aiDescriptions"];
  remaining: number;
  progress: number;
  backfillLimit: number;
  setBackfillLimit: (value: number) => void;
  pending: boolean;
  onBackfill: () => void;
  expanded?: boolean;
}) {
  return (
    <AdminPanel className="p-5">
      <AdminSectionHeading
        title="Synthèses IA manquantes"
        description={
          expanded
            ? `Version attendue : ${aiDescriptions?.expectedPromptVersion ?? "chargement…"}`
            : undefined
        }
      />
      <div className="mt-5 grid gap-5 md:grid-cols-[auto_1fr_auto_auto] md:items-center">
        <div
          className="grid size-20 place-items-center rounded-full text-lg font-semibold text-[#132238]"
          style={{
            background: `radial-gradient(circle closest-side, white 78%, transparent 80% 100%), conic-gradient(#216ac0 ${progress}%, #e6edf5 0)`,
          }}
          aria-label={`${progress}% des synthèses prêtes`}
        >
          {progress}%
        </div>
        <div>
          <strong className="text-2xl tabular-nums text-[#132238]">
            {formatInteger(aiDescriptions?.ready ?? 0)} /{" "}
            {formatInteger(aiDescriptions?.activeOrUpcoming ?? 0)}
          </strong>
          <p className="mt-1 text-sm text-[#132238]/62">
            {remaining} annonce{remaining > 1 ? "s" : ""} à traiter
          </p>
        </div>
        <label className="grid gap-2 text-sm font-medium text-[#132238]">
          Taille du lot
          <input
            type="number"
            min={1}
            max={100}
            value={backfillLimit}
            onChange={(event) =>
              setBackfillLimit(Math.max(1, Math.min(100, Number(event.target.value) || 20)))
            }
            className="h-11 w-32 rounded-lg border border-[#132238]/18 bg-white px-3 text-sm outline-none focus:border-[#c98d45]"
          />
        </label>
        <button
          type="button"
          disabled={pending || remaining === 0}
          onClick={onBackfill}
          className="admin-button-secondary md:self-end"
        >
          {pending ? <RefreshCw className="size-4 animate-spin" /> : <Bot className="size-4" />}
          Lancer le backfill
        </button>
      </div>
    </AdminPanel>
  );
}

function runnerModeLabel(mode: RunnerMode): string {
  if (mode === "github_actions") return "GitHub Actions";
  if (mode === "webhook") return "Webhook";
  return "Worker planifié";
}

function asAdminScrollSource(value: string | null): AdminScrollSource {
  return SOURCE_OPTIONS.some((option) => option.value === value)
    ? (value as AdminScrollSource)
    : "all";
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("fr-FR").format(value);
}

function formatRelativeTime(value: string): string {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return "à l’instant";
  if (elapsedMinutes < 60) return `il y a ${elapsedMinutes} min`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return formatDateTime(value);
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
    <article className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
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
                  className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-muted-foreground"
                >
                  {type}
                </span>
              ))
            ) : (
              <span className="rounded-full border border-amber-300/20 bg-amber-400/10 px-2.5 py-1 text-xs text-amber-100">
                Types de pièces à vérifier
              </span>
            )}
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            Demandeur : {request.requester_email ?? "email inconnu"} · {documents.length} fichier
            {documents.length > 1 ? "s" : ""} privé{documents.length > 1 ? "s" : ""}
          </div>
          {documents.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {documents.slice(0, 4).map((document) => (
                <button
                  key={document.path ?? document.name}
                  type="button"
                  onClick={() => void openPublicationDocument(document)}
                  className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-gold transition hover:border-gold"
                >
                  {document.name ?? "Ouvrir la pièce"}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 lg:justify-end">
          <button
            type="button"
            disabled={disabled || request.status === "approved"}
            onClick={() => onReview("approved")}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-300/20 bg-emerald-400/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-100 transition hover:border-emerald-200 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <CheckCircle className="h-3.5 w-3.5" />
            Valider
          </button>
          <button
            type="button"
            disabled={disabled || request.status === "rejected"}
            onClick={() => onReview("rejected")}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-300/20 bg-red-500/10 px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-red-100 transition hover:border-red-200 disabled:cursor-not-allowed disabled:opacity-45"
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
      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
      : status === "rejected"
        ? "border-red-300/20 bg-red-500/10 text-red-100"
        : "border-amber-300/20 bg-amber-400/10 text-amber-100";

  return (
    <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs ${tone}`}>
      {label}
    </span>
  );
}

function LatestRun({ run }: { run: AuctionRun }) {
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-xs text-muted-foreground">{shortId(run.id)}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusPill status={run.status} />
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-muted-foreground">
              {run.source ?? "source inconnue"}
            </span>
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-muted-foreground">
              {run.useLlm === false ? "Sans LLM" : "LLM auto"}
            </span>
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>{run.startedAt ? formatDateTime(run.startedAt) : "—"}</div>
          <div className="mt-1">{runDuration(run)}</div>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <RunMetric label="Collectées" value={summaryNumber(run, "collected")} />
        <RunMetric label="Dédupliquées" value={summaryNumber(run, "deduplicated")} />
        <RunMetric label="Upsert" value={summaryNumber(run, "upserted")} />
      </div>

      {errorCount(run.errors) > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-300/20 bg-amber-400/10 p-3 text-xs text-amber-100">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          {errorCount(run.errors)} erreur{errorCount(run.errors) > 1 ? "s" : ""} à inspecter.
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-emerald-300/20 bg-emerald-400/10 p-3 text-xs text-emerald-100">
          <CheckCircle className="mr-1 inline h-3.5 w-3.5" />
          Aucun signal d'erreur remonté sur ce run.
        </div>
      )}
    </div>
  );
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="liquid-panel-soft rounded-lg p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "succeeded"
      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
      : status === "failed"
        ? "border-red-300/20 bg-red-500/10 text-red-100"
        : status === "running"
          ? "border-sky-300/20 bg-sky-400/10 text-sky-100"
          : "border-amber-300/20 bg-amber-400/10 text-amber-100";
  return (
    <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs ${tone}`}>
      {status}
    </span>
  );
}

function EmptyState({ label }: { label: string }) {
  return <p className="text-sm text-muted-foreground">{label}</p>;
}

function shortId(id: string): string {
  return id ? id.slice(0, 8) : "—";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function runDuration(run: AuctionRun): string {
  if (!run.startedAt) return "durée inconnue";
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const start = new Date(run.startedAt).getTime();
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  if (minutes < 1) return "moins d'une minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function summaryNumber(run: AuctionRun, key: string): string {
  const value = run.summary[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

function errorCount(errors: Record<string, unknown>): number {
  let total = 0;
  for (const value of Object.values(errors)) {
    if (Array.isArray(value)) {
      total += value.length;
    } else if (value) {
      total += 1;
    }
  }
  return total;
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

function formatPrice(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Mise à prix à préciser";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}
