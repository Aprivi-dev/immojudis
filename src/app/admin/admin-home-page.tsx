"use client";

import { useQuery } from "@tanstack/react-query";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle.js";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import Play from "lucide-react/dist/esm/icons/play.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Link from "next/link";
import type { ReactNode } from "react";
import { AdminOperationalAlerts } from "@/components/admin/AdminOperationalAlerts";
import { adminReadinessQuery } from "@/components/admin/admin-readiness-query";
import { AdminPanel, AdminSectionHeading, AdminShell } from "@/components/admin/AdminShell";
import {
  errorCount,
  formatInteger,
  formatRelativeTime,
  queryErrorMessage,
} from "@/components/admin/admin-format";
import { AdminPill } from "@/components/admin/admin-pill";
import { AdminQueryErrorNotice, StatusPill, useAdminRefresh } from "@/components/admin/admin-ui";
import {
  AUTOPILOT_QUERY_KEY,
  REVIEW_QUERY_KEY,
  UNROUTED_QUERY_KEY,
  autopilotQuery,
  reviewQuery,
  unroutedQuery,
} from "@/components/admin/information-agent-queries";
import { useAuth } from "@/hooks/use-auth";
import {
  DASHBOARD_QUERY_KEY,
  DASHBOARD_RUNS_QUERY_KEY,
  READINESS_QUERY_KEY,
} from "@/lib/admin-query-keys";
import type { AdminDashboardRunsData, AuctionRun } from "@/lib/admin.server";
import {
  fetchAdminDashboardRuns,
  fetchAdminPrivacyRequests,
  fetchAdminPublicationRequests,
} from "@/lib/client-api";
import { formatShortDate } from "@/lib/format/dates";
import { sourceDisplayName } from "@/lib/source-names";
import { privacyDeadlineLabel } from "@/lib/privacy-deadline";
import type { PrivacyRequestAdminSummary } from "@/lib/privacy-requests";

/** Compteurs propres à l'accueil (demandes RGPD, annonces à valider) : clés distinctes de leurs vues. */
const HOME_QUERY_KEY = ["admin-home"] as const;
/** Demandes RGPD ouvertes détaillées sur l'accueil ; les suivantes sont dans Conformité. */
const SHOWN_PRIVACY_REQUESTS = 3;

/**
 * Accueil « À traiter » : ce qui demande une action, chaque point avec un lien vers l'endroit où agir.
 * Toutes les données viennent des routes des vues (mêmes clés pour l'agent et le diagnostic : la vue
 * ouverte ensuite les trouve en cache). La pastille de santé ne passe au vert que si aucune exécution
 * récente n'a échoué ET qu'aucune alerte d'exploitation n'est ouverte.
 */
export function AdminHomePage() {
  const { user } = useAuth();
  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: DASHBOARD_RUNS_QUERY_KEY,
    queryFn: fetchAdminDashboardRuns,
    staleTime: 30_000,
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.stats.queuedRuns || query.state.data?.stats.runningRuns ? 10_000 : 60_000,
  });
  const readiness = useQuery(adminReadinessQuery());
  const { isRefreshing, refresh } = useAdminRefresh([
    DASHBOARD_QUERY_KEY[0],
    READINESS_QUERY_KEY[0],
    AUTOPILOT_QUERY_KEY[0],
    REVIEW_QUERY_KEY[0],
    UNROUTED_QUERY_KEY[0],
    HOME_QUERY_KEY[0],
  ]);
  const failedRuns = data?.stats.failedRuns ?? null;
  const openAlerts = readiness.data?.operations.openAlertCount ?? null;
  // Une erreur des exécutions s'affiche tout de suite ; sinon le verdict attend aussi les alertes.
  const healthState =
    isLoading && !data
      ? "loading"
      : error && !data
        ? "error"
        : readiness.isPending
          ? "loading"
          : error
            ? "stale"
            : "ready";
  const needsIntervention = Boolean(failedRuns) || Boolean(openAlerts);
  const healthy = healthState === "ready" && failedRuns === 0 && openAlerts === 0;
  const retry = () => void refetch();

  return (
    <AdminShell
      activeSection="overview"
      title="Vue d’ensemble"
      description="À traiter : alertes, Agent IA, demandes RGPD et collectes."
      adminEmail={data?.adminEmail ?? user?.email}
      onRefresh={() => void refresh()}
      isRefreshing={isRefreshing}
      primaryAction={
        <Link href="/admin/operations" className="admin-button-primary">
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
        <AdminPanel className="flex items-start gap-4 p-5 sm:gap-5 sm:p-6">
          <span
            className={`grid size-12 shrink-0 place-items-center rounded-full sm:size-14 ${
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
          <div className="min-w-0 flex-1">
            <h2 className="text-xl font-semibold text-brand-navy">
              {healthState === "loading"
                ? "Vérification de la santé…"
                : healthState === "error"
                  ? "État de santé indisponible"
                  : healthState === "stale"
                    ? "Données de santé potentiellement obsolètes"
                    : needsIntervention
                      ? "Une intervention est requise"
                      : openAlerts === null
                        ? "Alertes indisponibles : santé incomplète"
                        : "Aucune alerte ni échec récent"}
            </h2>
            <p className="mt-2 text-sm text-brand-navy/60">
              {data?.checkedAt
                ? `${error ? "Dernière vérification" : "Vérifié"} ${formatRelativeTime(data.checkedAt)} · santé calculée sur les alertes ouvertes et les exécutions récentes`
                : "Les résultats apparaîtront après la vérification du tableau de bord."}
            </p>
            {healthState === "error" ? (
              <div role="alert" className="mt-3 text-sm text-red-700">
                <p>{queryErrorMessage(error, "Erreur de chargement admin")}</p>
                <button type="button" className="admin-button-secondary mt-3" onClick={retry}>
                  Réessayer
                </button>
              </div>
            ) : null}
            {data ? <CollectionsLine data={data} /> : null}
          </div>
        </AdminPanel>

        <AdminOperationalAlerts />

        <div className="grid gap-3 xl:grid-cols-2">
          <AgentSection />
          <PrivacySection />
        </div>

        <PublicationsSection />

        <AdminPanel className="p-5">
          <AdminSectionHeading
            title="Retours de la semaine"
            description="Ce que disent les comptes, à lire chaque lundi (30 minutes)."
          />
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <li>
              <Link href="/admin/pilotage" className="font-semibold text-gold-text underline">
                Pilotage
              </Link>{" "}
              : retours « Utile / Pas pertinent », questionnaire de la liste d’attente, parcours.
            </li>
            <li>
              <Link
                href="/admin/comptes?onglet=inscriptions"
                className="font-semibold text-gold-text underline"
              >
                Inscriptions
              </Link>{" "}
              : nouveaux comptes, essais qui finissent, essais finis sans activité.
            </li>
            <li>
              <Link
                href="/admin/quality?onglet=pepites"
                className="font-semibold text-gold-text underline"
              >
                Pépites
              </Link>{" "}
              : compteurs, presque-pépites, retours négatifs par vente.
            </li>
          </ul>
        </AdminPanel>
      </div>
    </AdminShell>
  );
}

/** « 2 collectées », « 1 intégrée » : nombre et mot accordé. */
function quantity(value: number, singular: string, plural: string): string {
  return `${formatInteger(value)} ${value > 1 ? plural : singular}`;
}

/** Source d'une collecte : nom lisible, ou « toutes les sources » pour un lancement complet (`all`). */
function runSourceName(source: string | null): string {
  if (!source) return "source inconnue";
  if (source === "all") return "toutes les sources";
  return sourceDisplayName(source) ?? source;
}

function summaryCount(run: AuctionRun, key: string): number | null {
  const value = run.summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Santé des collectes en une ligne : dernière exécution, volumes, file, échecs récents. */
function CollectionsLine({ data }: { data: AdminDashboardRunsData }) {
  const run = data.runs[0] ?? null;
  const collected = run ? summaryCount(run, "collected") : null;
  const integrated = run ? summaryCount(run, "upserted") : null;
  const errors = run ? errorCount(run.errors) : 0;
  const facts = [
    collected === null ? null : quantity(collected, "collectée", "collectées"),
    integrated === null ? null : quantity(integrated, "intégrée", "intégrées"),
    `${formatInteger(data.stats.queuedRuns)} en file`,
    `${formatInteger(data.stats.runningRuns)} en cours`,
    quantity(data.stats.failedRuns, "échec récent", "échecs récents"),
    errors ? quantity(errors, "erreur à inspecter", "erreurs à inspecter") : null,
  ].filter(Boolean);
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-brand-navy/80">
      <span className="font-semibold text-brand-navy">Collectes :</span>
      {run ? (
        <>
          <span>dernière exécution</span>
          <StatusPill status={run.status} />
          <span>
            {runSourceName(run.source)}
            {run.startedAt ? `, ${formatRelativeTime(run.startedAt)}` : ""}
          </span>
        </>
      ) : (
        <span>aucune exécution trouvée</span>
      )}
      <span>· {facts.join(" · ")}</span>
      <Link
        href="/admin/operations"
        className="inline-flex items-center gap-1 font-semibold text-gold-text"
      >
        Voir les collectes <ChevronRight className="size-4" />
      </Link>
    </p>
  );
}

function PlaceLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-gold-text"
    >
      {children} <ChevronRight className="size-4" />
    </Link>
  );
}

/** Ligne d'une section : texte à gauche, lien vers l'endroit où agir à droite (dessous à 390 px). */
function TodoLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm text-brand-navy/80">{children}</div>
      {action}
    </div>
  );
}

function Unavailable({ children }: { children: ReactNode }) {
  return <p className="text-sm text-red-700">{children}</p>;
}

/** État du pilote (lecture seule) et réponses à traiter, lus par les requêtes de l'Agent IA. */
function AgentSection() {
  const pilot = useQuery(autopilotQuery());
  const review = useQuery(reviewQuery(0));
  const unrouted = useQuery(unroutedQuery(0));
  const replies = review.data?.messagesTotal ?? null;
  const unroutedCount = unrouted.data?.total ?? null;

  return (
    <AdminPanel className="p-5">
      <AdminSectionHeading title="Agent IA" />
      <div className="mt-1 divide-y divide-brand-navy/10">
        <TodoLine action={<PlaceLink href="/admin/agent-ia?onglet=pilote">Pilote</PlaceLink>}>
          Pilote automatique :{" "}
          {pilot.data ? (
            <strong className="text-brand-navy">{pilot.data.modeLabel}</strong>
          ) : pilot.isError ? (
            "indisponible"
          ) : (
            "…"
          )}
          {pilot.data?.notice ? (
            <p
              className={`mt-1 text-xs leading-5 ${
                pilot.data.notice.tone === "alert" ? "text-danger" : "text-warning"
              }`}
            >
              {pilot.data.notice.text}
            </p>
          ) : null}
        </TodoLine>
        {review.isError || unrouted.isError ? (
          <TodoLine>
            <Unavailable>Réponses indisponibles pour le moment.</Unavailable>
          </TodoLine>
        ) : replies === null || unroutedCount === null ? (
          <TodoLine>
            <span role="status">Chargement des réponses…</span>
          </TodoLine>
        ) : replies === 0 && unroutedCount === 0 ? (
          <TodoLine>Aucune réponse à traiter</TodoLine>
        ) : (
          <TodoLine action={<PlaceLink href="/admin/agent-ia?onglet=reponses">Réponses</PlaceLink>}>
            <ul className="space-y-1">
              {replies ? (
                <li>{quantity(replies, "réponse reçue à traiter", "réponses reçues à traiter")}</li>
              ) : null}
              {unroutedCount ? (
                <li>
                  {quantity(
                    unroutedCount,
                    "message non rattaché en attente",
                    "messages non rattachés en attente",
                  )}
                </li>
              ) : null}
            </ul>
          </TodoLine>
        )}
      </div>
    </AdminPanel>
  );
}

function deadlineTone({ deadline }: PrivacyRequestAdminSummary) {
  return deadline.overdue ? "danger" : deadline.dueSoon ? "warning" : "neutral";
}

/** Demandes RGPD ouvertes et leur échéance (délai d'un mois, calculé par `privacy-deadline`). */
function PrivacySection() {
  const query = useQuery({
    queryKey: [...HOME_QUERY_KEY, "rgpd"],
    queryFn: () => fetchAdminPrivacyRequests(),
    staleTime: 30_000,
  });
  const data = query.data;
  // `daysRemaining` est null pour une demande close : `privacyDeadlineStatus` en décide.
  const open = (data?.requests ?? [])
    .filter((request) => request.deadline.daysRemaining !== null)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .slice(0, SHOWN_PRIVACY_REQUESTS);

  return (
    <AdminPanel className="p-5">
      <AdminSectionHeading title="Demandes RGPD" />
      <div className="mt-1">
        {query.isError ? (
          <TodoLine>
            <Unavailable>Demandes RGPD indisponibles pour le moment.</Unavailable>
          </TodoLine>
        ) : !data ? (
          <TodoLine>
            <span role="status">Chargement des demandes…</span>
          </TodoLine>
        ) : data.openCount === 0 ? (
          <TodoLine>Aucune demande RGPD ouverte</TodoLine>
        ) : (
          <TodoLine action={<PlaceLink href="/admin/compliance">Conformité</PlaceLink>}>
            <p className="font-medium text-brand-navy">
              {quantity(data.openCount, "demande ouverte", "demandes ouvertes")}
              {data.overdueCount ? `, dont ${formatInteger(data.overdueCount)} en retard` : ""}
            </p>
            {open.length ? (
              <ul className="mt-2 space-y-1">
                {open.map((request) => (
                  <li key={request.id} className="flex flex-wrap items-center gap-2">
                    <span>
                      Reçue le {formatShortDate(request.submittedAt)} · échéance le{" "}
                      {formatShortDate(request.dueAt)}
                    </span>
                    <AdminPill tone={deadlineTone(request)}>
                      {privacyDeadlineLabel(request.deadline)}
                    </AdminPill>
                  </li>
                ))}
              </ul>
            ) : null}
          </TodoLine>
        )}
      </div>
    </AdminPanel>
  );
}

/** Annonces de professionnels à valider : la section n'existe que s'il y en a. */
function PublicationsSection() {
  const query = useQuery({
    queryKey: [...HOME_QUERY_KEY, "annonces"],
    queryFn: () => fetchAdminPublicationRequests({ status: "pending", limit: 1 }),
    staleTime: 30_000,
  });
  const pending = query.data?.pendingCount ?? 0;
  if (!pending) return null;
  return (
    <AdminPanel className="p-5">
      <AdminSectionHeading title="Annonces de professionnels" />
      <div className="mt-1">
        <TodoLine action={<PlaceLink href="/admin/publications">Publications</PlaceLink>}>
          {quantity(
            pending,
            "annonce en attente de validation",
            "annonces en attente de validation",
          )}
        </TodoLine>
      </div>
    </AdminPanel>
  );
}
