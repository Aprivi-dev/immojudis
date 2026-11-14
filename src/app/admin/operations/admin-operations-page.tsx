"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import { useState } from "react";
import { toast } from "@/lib/toast";
import { AdminPipelinePanel } from "@/components/admin/AdminPipelinePanel";
import { OperationsRunTable, RunDetails, SOURCE_OPTIONS } from "@/components/admin/AdminRunPanels";
import {
  AdminPanel,
  AdminPrimaryButton,
  AdminSectionHeading,
  AdminShell,
} from "@/components/admin/AdminShell";
import {
  formatInteger,
  formatRelativeTime,
  queryErrorMessage,
} from "@/components/admin/admin-format";
import {
  AdminQueryErrorNotice,
  OverviewMetric,
  PipelineStat,
  useAdminRefresh,
} from "@/components/admin/admin-ui";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import {
  DASHBOARD_QUERY_KEY,
  DASHBOARD_RUNS_QUERY_KEY,
  PIPELINE_QUERY_KEY,
} from "@/lib/admin-query-keys";
import type { AdminRunRequest } from "@/lib/admin-run-actions";
import { collectionTransportNote } from "@/lib/admin-source-collection";
import type { AdminDashboardRunsData, AdminScrollSource, AuctionRun } from "@/lib/admin.server";
import {
  fetchAdminDashboardCounts,
  fetchAdminDashboardRuns,
  startAdminScrollRequest,
} from "@/lib/client-api";

type OperationsTab = "collections" | "documents" | "alerts";

/**
 * Vue « Opérations ». Chaque bloc ne charge que ce qu'il affiche : les runs (rapide, relus toutes
 * les 10 s tant qu'un run est actif) et les comptages de tables (onglet Documents seulement).
 */
export function AdminOperationsPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [source, setSource] = useState<AdminScrollSource>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState<OperationsTab>("collections");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  // Collecte à lancer après confirmation (bouton « Lancer » ou « Relancer » d'un run).
  const [pendingLaunch, setPendingLaunch] = useState<AdminRunRequest | null>(null);

  const runsQuery = useQuery({
    queryKey: DASHBOARD_RUNS_QUERY_KEY,
    queryFn: fetchAdminDashboardRuns,
    staleTime: 30_000,
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.stats.queuedRuns || query.state.data?.stats.runningRuns ? 10_000 : 60_000,
  });
  const countsQuery = useQuery({
    queryKey: [...DASHBOARD_QUERY_KEY, "counts"],
    queryFn: fetchAdminDashboardCounts,
    staleTime: 60_000,
    retry: 1,
    enabled: activeTab === "documents",
  });
  const { isRefreshing, refresh } = useAdminRefresh([
    DASHBOARD_QUERY_KEY[0],
    PIPELINE_QUERY_KEY[0],
  ]);

  const startMutation = useMutation({
    // Appelée seulement depuis la confirmation : le serveur exige `confirm: true`.
    mutationFn: (request: AdminRunRequest) =>
      startAdminScrollRequest({ data: { ...request, confirm: true } }),
    onSuccess: async (result) => {
      toast.success(result.message);
      await queryClient.invalidateQueries({ queryKey: DASHBOARD_RUNS_QUERY_KEY });
    },
    onError: async (err) => {
      toast.error(queryErrorMessage(err, "Impossible de lancer la collecte"));
      await queryClient.invalidateQueries({ queryKey: DASHBOARD_RUNS_QUERY_KEY });
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
        counts={countsQuery.data?.counts}
        countsError={countsQuery.error}
        source={source}
        setSource={setSource}
        selectedRun={selectedRun}
        onSelectRun={setSelectedRunId}
        runs={filteredRuns}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        startMutationPending={startMutation.isPending}
        onStart={(requestedSource) =>
          setPendingLaunch({ source: requestedSource ?? source, mode: "collect" })
        }
        onRestart={setPendingLaunch}
      />
      <Dialog
        open={pendingLaunch !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLaunch(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lancer une collecte ?</DialogTitle>
            <DialogDescription>
              Source :{" "}
              {SOURCE_OPTIONS.find((option) => option.value === pendingLaunch?.source)?.label ??
                pendingLaunch?.source}
              . La demande part tout de suite vers le runner de collecte. Une seule collecte à la
              fois par source : une seconde demande est refusée tant que la première est en file ou
              en cours.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <button type="button" className="admin-button-secondary">
                Annuler
              </button>
            </DialogClose>
            <button
              type="button"
              className="admin-button-primary"
              onClick={() => {
                if (pendingLaunch) startMutation.mutate(pendingLaunch);
                setPendingLaunch(null);
              }}
            >
              Lancer la collecte
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function AdminOperations({
  data,
  isLoading,
  counts,
  countsError,
  source,
  setSource,
  selectedRun,
  onSelectRun,
  runs,
  activeTab,
  onTabChange,
  startMutationPending,
  onStart,
  onRestart,
}: {
  data?: AdminDashboardRunsData;
  isLoading: boolean;
  counts?: { documents: number; extractions: number };
  countsError: unknown;
  source: AdminScrollSource;
  setSource: (value: AdminScrollSource) => void;
  selectedRun: AuctionRun | null;
  onSelectRun: (id: string) => void;
  runs: AuctionRun[];
  activeTab: OperationsTab;
  onTabChange: (tab: OperationsTab) => void;
  startMutationPending: boolean;
  onStart: (source?: AdminScrollSource) => void;
  onRestart: (request: AdminRunRequest) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 xl:grid-cols-[1fr_25rem]">
        <AdminPanel className="p-5">
          <AdminSectionHeading title="Lancer une collecte" />
          <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <label className="grid gap-2 text-sm font-medium text-brand-navy">
              Source
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as AdminScrollSource)}
                className="h-11 rounded-lg border border-brand-navy/18 bg-white px-3 text-sm transition focus:border-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
              >
                {SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
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
              restartPending={startMutationPending}
            />
          </div>
          {(data?.stats.failedRuns ?? 0) > 0 ? (
            <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
              <AlertTriangle className="size-5 shrink-0" />
              {data?.stats.failedRuns} run{(data?.stats.failedRuns ?? 0) > 1 ? "s" : ""} en échec
              nécessite{(data?.stats.failedRuns ?? 0) > 1 ? "nt" : ""} une vérification.
            </div>
          ) : null}
        </>
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
