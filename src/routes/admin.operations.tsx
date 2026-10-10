"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import { useState } from "react";
import { toast } from "sonner";
import { AdminPipelinePanel } from "@/components/admin/AdminPipelinePanel";
import {
  AiBackfillPanel,
  OperationsRunTable,
  RunDetails,
  SOURCE_OPTIONS,
} from "@/components/admin/AdminRunPanels";
import {
  AdminPanel,
  AdminPrimaryButton,
  AdminSectionHeading,
  AdminShell,
} from "@/components/admin/AdminShell";
import { formatInteger, formatRelativeTime } from "@/components/admin/admin-format";
import {
  AdminQueryErrorNotice,
  OverviewMetric,
  PipelineStat,
  useAdminRefresh,
} from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";
import type { AdminRunRequest } from "@/lib/admin-run-actions";
import { collectionTransportNote } from "@/lib/admin-source-collection";
import type {
  AdminDashboardRunsData,
  AdminScrollSource,
  AiDescriptionDashboardStats,
  AuctionRun,
} from "@/lib/admin.functions";
import {
  fetchAdminDashboardAi,
  fetchAdminDashboardCounts,
  fetchAdminDashboardRuns,
  startAdminScrollRequest,
} from "@/lib/client-api";

type OperationsTab = "collections" | "enrichment" | "documents" | "alerts";

/**
 * Vue « Opérations ». Chaque bloc ne charge que ce qu'il affiche : les runs (rapide, relus toutes
 * les 10 s tant qu'un run est actif), la couverture IA (lecture de toutes les synthèses, hors de
 * l'onglet Documents) et les comptages de tables (onglet Documents seulement).
 */
export function AdminOperationsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<AdminScrollSource>("all");
  const [backfillLimit, setBackfillLimit] = useState(20);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<OperationsTab>("collections");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ["admin-dashboard", "runs"],
    queryFn: fetchAdminDashboardRuns,
    staleTime: 30_000,
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.stats.queuedRuns || query.state.data?.stats.runningRuns ? 10_000 : 60_000,
  });
  const aiQuery = useQuery({
    queryKey: ["admin-dashboard", "ai"],
    queryFn: fetchAdminDashboardAi,
    staleTime: 60_000,
    retry: 1,
    enabled: activeTab !== "documents",
  });
  const countsQuery = useQuery({
    queryKey: ["admin-dashboard", "counts"],
    queryFn: fetchAdminDashboardCounts,
    staleTime: 60_000,
    retry: 1,
    enabled: activeTab === "documents",
  });
  const { isRefreshing, refresh } = useAdminRefresh(["admin-dashboard", "admin-pipeline"]);

  const startMutation = useMutation({
    mutationFn: (request?: AdminRunRequest) =>
      startAdminScrollRequest({ data: request ?? { source, mode: "collect" } }),
    onSuccess: async (result) => {
      toast.success(result.message);
      await queryClient.invalidateQueries({ queryKey: ["admin-dashboard", "runs"] });
    },
    onError: async (err) => {
      toast.error(err instanceof Error ? err.message : "Impossible de lancer la collecte");
      await queryClient.invalidateQueries({ queryKey: ["admin-dashboard", "runs"] });
    },
  });
  const backfillMutation = useMutation({
    mutationFn: () =>
      startAdminScrollRequest({
        data: { source: "all", mode: "llm_backfill", limit: backfillLimit },
      }),
    onSuccess: async (result) => {
      toast.success(result.message);
      await queryClient.invalidateQueries({ queryKey: ["admin-dashboard", "runs"] });
    },
    onError: async (err) => {
      toast.error(err instanceof Error ? err.message : "Impossible de lancer le backfill IA");
      await queryClient.invalidateQueries({ queryKey: ["admin-dashboard", "runs"] });
    },
  });

  const data = runsQuery.data;
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
  const selectedRun = data?.runs.find((run) => run.id === selectedRunId) ?? data?.runs[0] ?? null;

  return (
    <AdminShell
      activeSection="operations"
      title="Opérations"
      description="Collecte, enrichissement et suivi des traitements."
      adminEmail={data?.adminEmail ?? user?.email}
      searchValue={searchQuery}
      searchPlaceholder="Rechercher un run…"
      onSearchChange={setSearchQuery}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
    >
      {runsQuery.error ? (
        <AdminQueryErrorNotice
          className="mb-4"
          error={runsQuery.error}
          fallback="Erreur de chargement admin"
          hasData={Boolean(data)}
          isRetrying={isRefreshing}
          onRetry={() => void refresh()}
        />
      ) : null}

      <AdminPipelinePanel />
      <AdminOperations
        data={data}
        isLoading={runsQuery.isLoading}
        ai={{
          stats: aiQuery.data?.aiDescriptions,
          status: aiQuery.error ? "error" : aiQuery.data ? "ready" : "loading",
        }}
        counts={countsQuery.data?.counts}
        countsError={countsQuery.error}
        source={source}
        setSource={setSource}
        selectedRun={selectedRun}
        onSelectRun={setSelectedRunId}
        runs={filteredRuns}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        backfillLimit={backfillLimit}
        setBackfillLimit={setBackfillLimit}
        startMutationPending={startMutation.isPending}
        onStart={(requestedSource) =>
          startMutation.mutate({ source: requestedSource ?? source, mode: "collect" })
        }
        onRestart={(request) => startMutation.mutate(request)}
        backfillPending={backfillMutation.isPending}
        onBackfill={() => backfillMutation.mutate()}
      />
    </AdminShell>
  );
}

type AiState = {
  stats?: AiDescriptionDashboardStats;
  status: "ready" | "loading" | "error";
};

function AdminOperations({
  data,
  isLoading,
  ai,
  counts,
  countsError,
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
  onRestart,
  backfillPending,
  onBackfill,
}: {
  data?: AdminDashboardRunsData;
  isLoading: boolean;
  ai: AiState;
  counts?: { documents: number; extractions: number };
  countsError: unknown;
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
  onRestart: (request: AdminRunRequest) => void;
  backfillPending: boolean;
  onBackfill: () => void;
}) {
  const aiDescriptions = ai.stats;
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
            <label className="grid gap-2 text-sm font-medium text-brand-navy">
              Source
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as AdminScrollSource)}
                className="h-11 rounded-lg border border-brand-navy/18 bg-white px-3 text-sm outline-none transition focus:border-gold focus:ring-2 focus:ring-gold/15"
              >
                {SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex h-11 items-center gap-3 text-sm text-brand-navy/75">
              <span className="grid size-5 place-items-center rounded bg-gold-soft text-white">
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
            <p className="mt-3 text-sm text-brand-navy/70" role="status">
              {collectionTransportNote(source)}
            </p>
          ) : null}
        </AdminPanel>

        <AdminPanel className="flex items-center gap-4 p-5">
          <span className="grid size-11 place-items-center rounded-full bg-brand-navy text-white">
            <Database className="size-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2 font-semibold text-brand-navy">
              {data ? runnerModeLabel(data.runner.mode) : "Vérification du runner"}
              <span
                className={runnerStatusClass(
                  data?.runner.mode === "queue_worker" ? undefined : data?.runner.status,
                )}
              >
                ·{" "}
                {runnerStatusLabel(
                  data?.runner.mode === "queue_worker" ? undefined : data?.runner.status,
                )}
              </span>
            </div>
            <p className="mt-1 text-sm text-brand-navy/58">
              {data?.checkedAt
                ? `Vérifié ${formatRelativeTime(data.checkedAt)}`
                : "Vérification du runner en attente"}
            </p>
          </div>
        </AdminPanel>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-brand-navy/14">
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
                ? "border-gold-soft text-gold-text"
                : "border-transparent text-brand-navy/58 hover:text-brand-navy"
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
              <div className="border-b border-brand-navy/10 px-5 py-4">
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
              onRestart={onRestart}
              restartPending={startMutationPending || backfillPending}
            />
          </div>
          <AiBackfillPanel
            aiDescriptions={aiDescriptions}
            status={ai.status}
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
          status={ai.status}
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
        <>
          {countsError ? (
            <p
              className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
              role="status"
            >
              Les comptages sont indisponibles pour le moment.
            </p>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <AdminPanel className="p-6">
              <OverviewMetric
                icon={<FileSearch />}
                value={counts ? formatInteger(counts.documents) : "—"}
                label="Documents indexés"
              />
            </AdminPanel>
            <AdminPanel className="p-6">
              <OverviewMetric
                icon={<Activity />}
                value={counts ? formatInteger(counts.extractions) : "—"}
                label="Extractions structurées"
              />
            </AdminPanel>
          </div>
        </>
      ) : null}

      {activeTab === "alerts" ? (
        <AdminPanel className="p-5">
          <AdminSectionHeading
            title="Alertes opérationnelles"
            description="Signaux calculés à partir des exécutions récentes"
          />
          <div className="mt-5 divide-y divide-brand-navy/10">
            <PipelineStat label="Runs en file" value={data?.stats.queuedRuns ?? null} />
            <PipelineStat label="Runs actifs" value={data?.stats.runningRuns ?? null} />
            <PipelineStat
              label="Runs échoués récents"
              value={data?.stats.failedRuns ?? null}
              danger={(data?.stats.failedRuns ?? 0) > 0}
            />
            <PipelineStat
              label="Synthèses IA à traiter"
              value={aiDescriptions?.backfillRemaining ?? null}
            />
          </div>
        </AdminPanel>
      ) : null}
    </div>
  );
}

function runnerModeLabel(mode: AdminDashboardRunsData["runner"]["mode"]): string {
  if (mode === "github_actions") return "GitHub Actions";
  if (mode === "webhook") return "Webhook";
  return "Runner non configuré";
}

function runnerStatusLabel(status: AdminDashboardRunsData["runner"]["status"]): string {
  if (status === "active") return "Actif";
  if (status === "suspended") return "Suspendu";
  return "Non vérifié";
}

function runnerStatusClass(status: AdminDashboardRunsData["runner"]["status"]): string {
  if (status === "active") return "text-emerald-700";
  if (status === "suspended") return "text-red-700";
  return "text-brand-navy/55";
}
