"use client";

import { useQuery } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import CreditCard from "lucide-react/dist/esm/icons/credit-card.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import FileCheck2 from "lucide-react/dist/esm/icons/file-check-2.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import type { ComponentType } from "react";
import { AdminPanel, AdminSectionHeading, AdminShell } from "@/components/admin/AdminShell";
import {
  errorCount,
  formatDateTime,
  formatRelativeTime,
  runDuration,
  shortId,
  summaryNumber,
} from "@/components/admin/admin-format";
import {
  AdminQueryErrorNotice,
  EmptyState,
  PipelineStat,
  StatusPill,
} from "@/components/admin/admin-ui";
import { useAuth } from "@/hooks/use-auth";
import type { AuctionRun } from "@/lib/admin.functions";
import { fetchAdminDashboardRuns } from "@/lib/client-api";
import { Link } from "@/lib/router-compat";

const ADMIN_VIEW_LINKS: Array<{
  href: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  {
    href: "/admin/operations",
    label: "Opérations",
    description: "Lancer une collecte, suivre les runs, l’enrichissement IA et les sources.",
    icon: Database,
  },
  {
    href: "/admin/agent-ia",
    label: "Agent IA",
    description: "Missions de prise de contact, faits à contrôler et template des e-mails.",
    icon: Bot,
  },
  {
    href: "/admin/quality",
    label: "Qualité des données",
    description: "Dossiers fragiles, couverture par source et modèles de valorisation.",
    icon: BarChart3,
  },
  {
    href: "/admin/publications",
    label: "Publications",
    description: "Valider ou refuser les annonces envoyées par les professionnels.",
    icon: FileCheck2,
  },
  {
    href: "/admin/clients",
    label: "Clients & abonnements",
    description: "Attribuer un plan et suivre les accès commerciaux.",
    icon: CreditCard,
  },
  {
    href: "/admin/lawyers",
    label: "Avocats",
    description: "Mises en relation et réseau d’avocats référencés.",
    icon: Scale,
  },
  {
    href: "/admin/compliance",
    label: "Conformité",
    description: "Demandes RGPD, rétractations et diagnostic de préparation.",
    icon: ShieldCheck,
  },
  {
    href: "/admin/settings",
    label: "Configuration",
    description: "Planification, limites IA et état des sources de données.",
    icon: Settings,
  },
];

/**
 * Accueil de l’administration : léger par construction. Une seule requête rapide (les 25 derniers
 * runs, section `runs` du tableau de bord) pour l’état de santé ; chaque vue charge ensuite ses
 * propres données quand on l’ouvre.
 */
export function AdminHomePage() {
  const { user } = useAuth();
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["admin-dashboard", "runs"],
    queryFn: fetchAdminDashboardRuns,
    staleTime: 30_000,
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.stats.queuedRuns || query.state.data?.stats.runningRuns ? 10_000 : 60_000,
  });
  const latestRun = data?.runs[0] ?? null;
  const failedRuns = data?.stats.failedRuns ?? null;
  const healthState =
    isLoading && !data ? "loading" : error && !data ? "error" : error && data ? "stale" : "ready";
  const healthy = healthState === "ready" && !error && failedRuns === 0;
  const retry = () => void refetch();

  return (
    <AdminShell
      activeSection="overview"
      title="Vue d’ensemble"
      description="Pilotez l’activité et traitez les priorités du jour."
      adminEmail={data?.adminEmail ?? user?.email}
      onRefresh={retry}
      isRefreshing={isFetching}
      primaryAction={
        <Link to="/admin/operations" className="admin-button-primary">
          <Play className="size-4" />
          Lancer une collecte
        </Link>
      }
    >
      {error && data ? (
        <AdminQueryErrorNotice
          className="mb-4"
          error={error}
          fallback="Erreur de chargement admin"
          hasData
          isRetrying={isFetching}
          onRetry={retry}
        />
      ) : null}

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
              <h2 className="text-xl font-semibold text-brand-navy">
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
              <p className="mt-2 text-sm text-brand-navy/60">
                {data?.checkedAt
                  ? `${error ? "Dernière vérification" : "Vérifié"} ${formatRelativeTime(data.checkedAt)} · santé calculée sur les exécutions récentes`
                  : "Les résultats apparaîtront après la vérification du dashboard."}
              </p>
              {healthState === "error" ? (
                <div role="alert" className="mt-3 text-sm text-red-700">
                  <p>{error instanceof Error ? error.message : "Erreur de chargement admin"}</p>
                  <button type="button" className="admin-button-secondary mt-3" onClick={retry}>
                    Réessayer
                  </button>
                </div>
              ) : null}
              <Link
                to="/admin/settings"
                className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-gold-text"
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
              <p className="mt-3 text-sm text-brand-navy/58" role="status">
                Chargement de l’activité…
              </p>
            ) : data ? (
              <PipelineActivityChart runs={data.runs} />
            ) : (
              <p className="mt-3 text-sm text-red-700">Activité indisponible.</p>
            )}
          </AdminPanel>
        </div>

        <div className="grid gap-3 xl:grid-cols-[1.55fr_0.75fr]">
          <AdminPanel className="p-5">
            <AdminSectionHeading title="Dernière collecte" />
            {latestRun ? (
              <LatestRun run={latestRun} />
            ) : (
              <EmptyState label={data ? "Aucun run trouvé" : "Données indisponibles"} />
            )}
            <Link
              to="/admin/operations"
              className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-gold-text"
            >
              Voir le détail <ChevronRight className="size-4" />
            </Link>
          </AdminPanel>
          <AdminPanel className="p-5">
            <AdminSectionHeading title="Santé du pipeline" />
            <div className="mt-4 divide-y divide-brand-navy/10">
              <PipelineStat label="Runs en file" value={data?.stats.queuedRuns ?? null} />
              <PipelineStat label="Runs actifs" value={data?.stats.runningRuns ?? null} />
              <PipelineStat
                label="Échecs récents"
                value={failedRuns}
                danger={Boolean(failedRuns)}
              />
            </div>
          </AdminPanel>
        </div>

        <nav aria-label="Vues de l’administration">
          <AdminSectionHeading
            title="Accès aux vues"
            description="Chaque vue charge uniquement ses propres données."
          />
          <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {ADMIN_VIEW_LINKS.map((view) => {
              const Icon = view.icon;
              return (
                <li key={view.href}>
                  <Link
                    to={view.href}
                    className="admin-panel flex h-full flex-col gap-2 p-4 transition hover:border-gold-soft"
                  >
                    <span className="flex items-center gap-2 font-semibold text-brand-navy">
                      <Icon className="size-5 text-info" />
                      {view.label}
                    </span>
                    <span className="text-sm text-brand-navy/62">{view.description}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </AdminShell>
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
function LatestRun({ run }: { run: AuctionRun }) {
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="font-mono text-xs text-muted-foreground">{shortId(run.id)}</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <StatusPill status={run.status} />
            <span className="rounded-full border border-brand-navy/10 px-2.5 py-1 text-xs text-muted-foreground">
              {run.source ?? "source inconnue"}
            </span>
            <span className="rounded-full border border-brand-navy/10 px-2.5 py-1 text-xs text-muted-foreground">
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
        <div className="mt-4 rounded-lg border border-amber-300/20 bg-warning-tint p-3 text-xs text-warning">
          <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
          {errorCount(run.errors)} erreur{errorCount(run.errors) > 1 ? "s" : ""} à inspecter.
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-emerald-300/20 bg-success-tint p-3 text-xs text-success">
          <CheckCircle className="mr-1 inline h-3.5 w-3.5" />
          Aucun signal d'erreur remonté sur ce run.
        </div>
      )}
    </div>
  );
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-panel rounded-lg p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}
