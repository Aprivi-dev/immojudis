import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import Activity from "lucide-react/dist/esm/icons/activity.js";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import ScrollText from "lucide-react/dist/esm/icons/scroll-text.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import {
  getAdminDashboard,
  startAdminScroll,
  type AdminDashboardData,
  type AdminScrollSource,
  type AuctionRun,
  type StartScrollResult,
} from "@/lib/admin.functions";

const SOURCE_OPTIONS: Array<{ value: AdminScrollSource; label: string }> = [
  { value: "all", label: "Toutes les sources" },
  { value: "avoventes", label: "Avoventes" },
  { value: "licitor", label: "Licitor" },
  { value: "vench", label: "Vench" },
  { value: "info_encheres", label: "Info Enchères" },
  { value: "encheres_publiques", label: "Enchères-Publiques" },
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

function AdminDashboardPage() {
  const queryClient = useQueryClient();
  const fetchDashboard = useServerFn(getAdminDashboard) as () => Promise<AdminDashboardData>;
  const requestScroll = useServerFn(startAdminScroll) as (args: {
    data: { source: AdminScrollSource; useLlm: boolean };
  }) => Promise<StartScrollResult>;
  const [source, setSource] = useState<AdminScrollSource>("all");
  const [useLlm, setUseLlm] = useState(true);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: () => fetchDashboard(),
    staleTime: 30_000,
  });

  const startMutation = useMutation({
    mutationFn: () => requestScroll({ data: { source, useLlm } }),
    onSuccess: async (result) => {
      toast.success(result.message);
      await queryClient.invalidateQueries({ queryKey: ["admin-dashboard"] });
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Impossible de lancer le scroll");
    },
  });

  const latestRun = data?.runs[0] ?? null;

  return (
    <main className="liquid-page min-h-screen px-4 py-8 text-foreground sm:px-6 lg:py-10">
      <div className="mx-auto max-w-7xl">
        <header className="liquid-hero rounded-lg p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
                <ShieldCheck className="h-4 w-4" />
                Vue administrateur
              </div>
              <h1 className="mt-4 font-display text-4xl leading-tight sm:text-5xl">
                Pilotage Immojudis
              </h1>
              <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                Supervision des runs de scroll, de la base Supabase et des traitements
                d'enrichissement utilisés par le scoring.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => refetch()}
                className="liquid-panel-soft inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold transition hover:border-gold"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
                Actualiser
              </button>
              <Link
                to="/admin/quality"
                className="liquid-button inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-background"
              >
                Qualité data
              </Link>
            </div>
          </div>
        </header>

        {error ? (
          <div className="liquid-panel mt-6 rounded-lg border-red-300/20 p-5 text-sm text-red-100">
            {error instanceof Error ? error.message : "Erreur de chargement admin"}
          </div>
        ) : null}

        <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <DashboardMetric
            icon={<Database />}
            label="Annonces"
            value={isLoading ? "..." : String(data?.stats.sales ?? 0)}
          />
          <DashboardMetric
            icon={<ScrollText />}
            label="Runs"
            value={isLoading ? "..." : String(data?.stats.runs ?? 0)}
          />
          <DashboardMetric
            icon={<FileSearch />}
            label="Documents"
            value={isLoading ? "..." : String(data?.stats.documents ?? 0)}
          />
          <DashboardMetric
            icon={<Activity />}
            label="Extractions"
            value={isLoading ? "..." : String(data?.stats.extractions ?? 0)}
          />
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="liquid-panel rounded-lg p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
                  <Play className="h-4 w-4" />
                  Nouveau scroll
                </div>
                <h2 className="mt-3 font-display text-2xl">Lancer une collecte</h2>
              </div>
              <RunnerStatus configured={Boolean(data?.runner.webhookConfigured)} />
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                Source
                <select
                  value={source}
                  onChange={(event) => setSource(event.target.value as AdminScrollSource)}
                  className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
                >
                  {SOURCE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="liquid-panel-soft flex items-center justify-between gap-4 rounded-lg px-4 py-3 text-sm">
                <span>
                  <span className="block font-medium text-foreground">Analyse LLM</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Extraction premium et preuves contextualisées.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={useLlm}
                  onChange={(event) => setUseLlm(event.target.checked)}
                  className="h-5 w-5 accent-[var(--gold)]"
                />
              </label>
            </div>

            <button
              type="button"
              disabled={startMutation.isPending}
              onClick={() => startMutation.mutate()}
              className="liquid-button mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {startMutation.isPending ? (
                <>
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  Demande en cours
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" />
                  Start scroll
                </>
              )}
            </button>

            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              Sans webhook configuré côté Vercel, le bouton enregistre la demande dans Supabase
              avec le statut `queued`. Un runner externe pourra ensuite la traiter.
            </p>
          </div>

          <div className="liquid-panel rounded-lg p-5">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
              <Clock className="h-4 w-4" />
              Dernier run
            </div>
            {latestRun ? <LatestRun run={latestRun} /> : <EmptyState label="Aucun run trouvé" />}
          </div>
        </section>

        <section className="mt-6 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
          <div className="liquid-panel rounded-lg p-5">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gold">
              Santé du pipeline
            </div>
            <div className="mt-4 grid gap-3">
              <HealthLine
                label="Runs en file"
                value={String(data?.stats.queuedRuns ?? 0)}
                tone={(data?.stats.queuedRuns ?? 0) > 0 ? "warn" : "ok"}
              />
              <HealthLine
                label="Runs actifs"
                value={String(data?.stats.runningRuns ?? 0)}
                tone={(data?.stats.runningRuns ?? 0) > 0 ? "ok" : "neutral"}
              />
              <HealthLine
                label="Runs échoués récents"
                value={String(data?.stats.failedRuns ?? 0)}
                tone={(data?.stats.failedRuns ?? 0) > 0 ? "bad" : "ok"}
              />
              <HealthLine
                label="Risques sourcés"
                value={String(data?.stats.riskOccurrences ?? 0)}
                tone="neutral"
              />
              <HealthLine
                label="Facteurs de score"
                value={String(data?.stats.scoreFactors ?? 0)}
                tone="neutral"
              />
            </div>
          </div>

          <div className="liquid-panel rounded-lg p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-gold">
                Historique des scans
              </div>
              <span className="text-xs text-muted-foreground">
                Vérifié {data?.checkedAt ? formatDateTime(data.checkedAt) : "—"}
              </span>
            </div>

            <div className="mt-4 overflow-hidden rounded-lg border border-white/10">
              <div className="grid grid-cols-[1fr_0.8fr_0.7fr_0.8fr] gap-3 bg-white/[0.04] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                <span>Run</span>
                <span>Source</span>
                <span>Statut</span>
                <span>Résultat</span>
              </div>
              <div className="divide-y divide-white/10">
                {data?.runs.length ? (
                  data.runs.map((run) => <RunLine key={run.id} run={run} />)
                ) : (
                  <div className="p-4">
                    <EmptyState label={isLoading ? "Chargement des runs" : "Aucun run"} />
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function DashboardMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactElement;
  label: string;
  value: string;
}) {
  return (
    <div className="liquid-panel-soft rounded-lg p-4">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
        <span className="text-gold [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        {label}
      </div>
      <div className="mt-3 font-display text-3xl tabular-nums text-foreground">{value}</div>
    </div>
  );
}

function RunnerStatus({ configured }: { configured: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
        configured
          ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100"
          : "border-amber-300/25 bg-amber-400/10 text-amber-100"
      }`}
    >
      <Bot className="h-3.5 w-3.5" />
      {configured ? "Webhook actif" : "Queue seule"}
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
              {run.useLlm ? "LLM" : "Sans LLM"}
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

function HealthLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "bad" | "neutral";
}) {
  const toneClass =
    tone === "ok"
      ? "text-emerald-100"
      : tone === "warn"
        ? "text-amber-100"
        : tone === "bad"
          ? "text-red-100"
          : "text-foreground";
  return (
    <div className="liquid-panel-soft flex items-center justify-between gap-4 rounded-lg p-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`font-semibold tabular-nums ${toneClass}`}>{value}</span>
    </div>
  );
}

function RunLine({ run }: { run: AuctionRun }) {
  return (
    <div className="grid grid-cols-[1fr_0.8fr_0.7fr_0.8fr] gap-3 px-3 py-3 text-sm">
      <span className="min-w-0">
        <span className="block truncate font-mono text-xs text-foreground">{shortId(run.id)}</span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {run.startedAt ? formatDateTime(run.startedAt) : "date inconnue"}
        </span>
      </span>
      <span className="truncate text-muted-foreground">{run.source ?? "—"}</span>
      <StatusPill status={run.status} />
      <span className="text-xs text-muted-foreground">
        {summaryNumber(run, "upserted")} upsert · {errorCount(run.errors)} err.
      </span>
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
