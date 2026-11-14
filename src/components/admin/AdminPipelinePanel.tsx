"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatNumericDateTime } from "@/lib/format/dates";
import { formatShareAsPercent } from "@/lib/format/numbers";
import { toast } from "@/lib/toast";
import { PIPELINE_QUERY_KEY } from "@/lib/admin-query-keys";
import { fetchPipelineStatus, setPipelineSourceEnabled } from "@/lib/client-api";
import {
  describeOperationalAlert,
  operationalAlertNotificationLabel,
} from "@/lib/operational-alert-labels";
import { pipelineSourceStatus } from "@/lib/pipeline-source-status";
function date(value: string | null) {
  return formatNumericDateTime(value, "Non établie");
}
/** Sous `md`, chaque source devient une carte : l'en-tête est masqué et chaque cellule nomme sa colonne. */
const COLUMNS = [
  "Source",
  "État",
  "Inventaire complet",
  "Publication complète",
  "Fiches vérifiées à temps",
  "Planification",
] as const;
const CELL = "p-2 max-md:block max-md:px-0 max-md:py-1";
function CellLabel({ column }: { column: (typeof COLUMNS)[number] }) {
  return <span className="block text-xs font-semibold text-slate-600 md:hidden">{column}</span>;
}
export function AdminPipelinePanel() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: PIPELINE_QUERY_KEY,
    queryFn: fetchPipelineStatus,
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });
  const mutation = useMutation({
    mutationFn: ({ source, enabled }: { source: string; enabled: boolean }) =>
      setPipelineSourceEnabled(source, enabled),
    onSuccess: async (_, variables) => {
      toast.success(
        `${variables.source} : planification ${variables.enabled ? "activée" : "suspendue"}.`,
      );
      await client.invalidateQueries({ queryKey: PIPELINE_QUERY_KEY });
    },
  });
  if (query.isPending) return <p role="status">Chargement de la supervision…</p>;
  if (!query.data)
    return (
      <div className="rounded-xl border bg-white p-5">
        <p role="alert" className="text-sm text-red-700">
          La supervision des sources est indisponible. {query.error?.message}
        </p>
        <button
          type="button"
          className="admin-button-secondary mt-3"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Réessayer
        </button>
      </div>
    );
  const data = query.data;
  return (
    <section
      className="mb-4 rounded-xl border bg-white p-5 space-y-4"
      aria-labelledby="pipeline-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="pipeline-title" className="text-lg font-semibold">
            Collecte automatique par source
          </h2>
          <p className="text-sm text-slate-600">
            {data.control.enabled ? "Planification active" : "Planification suspendue"} ·
            Observation : {date(data.control.observation_started_at)}
          </p>
        </div>
        <button
          type="button"
          className="admin-button-secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Actualisation…" : "Actualiser les sources"}
        </button>
      </div>
      {query.error ? (
        <p role="alert" className="text-sm text-amber-800">
          Actualisation impossible. Les dernières données reçues restent affichées.
        </p>
      ) : null}
      <p className="text-sm leading-6 text-slate-600">
        Activez uniquement les sources à inclure dans les prochaines collectes. Une source activée
        peut rester temporairement bloquée par son délai de reprise. Les états ci-dessous décrivent
        la dernière observation.
      </p>
      <p className="text-sm">
        Aujourd’hui (UTC) : {data.usage.ai_requests} appels IA, coût estimé{" "}
        {data.usage.ai_estimated_usd.toFixed(3)} $ / plafond {data.usage.daily_ai_budget_usd} $.{" "}
        {data.usage.ai_unpriced_requests} appels sans coût final connu. Exécution collecte et
        enrichissement : {Math.round(data.usage.runner_seconds / 60)} min.{" "}
        <a
          className="underline"
          href="https://replicate.com/pricing"
          target="_blank"
          rel="noreferrer"
        >
          Tarif utilisé
        </a>{" "}
        (L40S, vérifié le 12/09/2026).
      </p>
      {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
      {!data.sources.length ? (
        <p className="rounded-lg bg-slate-50 p-4 text-sm">
          Aucune source configurée. Consultez les diagnostics des services pour vérifier
          l’installation du pipeline.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm max-md:block">
          <thead className="max-md:sr-only">
            <tr>
              {COLUMNS.map((column) => (
                <th key={column} className="p-2">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="max-md:block max-md:space-y-3">
            {data.sources.map((source) => {
              const metrics = data.observations.find(
                (item) => item.source_name === source.source_name,
              )?.metrics;
              const ratio = metrics?.freshness_ratio;
              const status = pipelineSourceStatus(source);
              return (
                <tr
                  key={source.source_name}
                  className="border-t align-top max-md:block max-md:rounded-lg max-md:border max-md:p-3"
                >
                  <th className={`${CELL} font-medium`}>{source.source_name}</th>
                  <td className={CELL}>
                    <CellLabel column="État" />
                    {status.label}
                    {status.detail ? (
                      <p className="max-w-xs text-xs text-slate-600">{status.detail}</p>
                    ) : null}
                    {source.last_attempt_at ? (
                      <p className="text-xs">Dernière tentative : {date(source.last_attempt_at)}</p>
                    ) : null}
                    {source.last_error ? (
                      <details>
                        <summary className="cursor-pointer text-red-700">Erreur</summary>
                        <p className="max-w-md break-words">{source.last_error}</p>
                      </details>
                    ) : null}
                  </td>
                  <td className={CELL}>
                    <CellLabel column="Inventaire complet" />
                    {date(source.last_inventory_complete_at)}
                    {source.coverage?.scoped_inventory_complete ? (
                      <p className="max-w-xs text-xs">
                        Périmètre accessible complet ; archives sans lien exclues.
                      </p>
                    ) : null}
                  </td>
                  <td className={CELL}>
                    <CellLabel column="Publication complète" />
                    {date(source.last_publication_complete_at)}
                    {typeof source.coverage?.publication_published === "number" ? (
                      <p className="text-xs">
                        Dernier passage : {source.coverage.publication_published} publiées,{" "}
                        {source.coverage.publication_pending ?? 0} à finaliser.
                      </p>
                    ) : null}
                    {source.coverage?.publication_blockers?.length ? (
                      <p className="text-xs">
                        Bloquée par : {source.coverage.publication_blockers.join(", ")}.
                      </p>
                    ) : null}
                    {typeof metrics?.discovery_to_publication_p95_seconds === "number" ? (
                      <p>
                        Délai de publication, p95 :{" "}
                        {Math.round(metrics.discovery_to_publication_p95_seconds)} s
                      </p>
                    ) : null}
                    {metrics?.decisions && typeof metrics.decisions === "object" ? (
                      <details>
                        <summary>Répartition des décisions</summary>
                        <ul>
                          {Object.entries(metrics.decisions).map(([decision, count]) => (
                            <li key={decision}>
                              {decision} : {String(count)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td className={CELL}>
                    <CellLabel column="Fiches vérifiées à temps" />
                    {typeof ratio === "number"
                      ? `${formatShareAsPercent(ratio)} (${metrics?.fresh_listings}/${metrics?.active_listings})`
                      : "Non mesuré"}
                  </td>
                  <td className={CELL}>
                    <CellLabel column="Planification" />
                    <span className="mb-2 block text-xs font-medium">
                      {source.enabled ? "Activée" : "Suspendue"}
                    </span>
                    <button
                      type="button"
                      className="rounded border px-3 py-1 disabled:opacity-50"
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({ source: source.source_name, enabled: !source.enabled })
                      }
                    >
                      {source.enabled ? "Suspendre" : "Activer"} {source.source_name}
                    </button>
                    {source.suspended_until ? (
                      <p>Reprise au plus tôt : {date(source.suspended_until)}</p>
                    ) : source.last_error ? (
                      <p>Reprise possible à partir du : {date(source.next_inventory_at)}</p>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-slate-600">
        Une suspension empêche les prochains départs. Le lot déjà en cours peut se terminer. Les
        pourcentages mesurent la fraîcheur des fiches ; ils ne constituent pas une preuve de
        couverture de la source.
      </p>
      <ul className="text-sm">
        {data.alerts
          .filter((alert) => alert.status === "open")
          .map((alert) => (
            <li key={alert.alert_key}>
              {describeOperationalAlert(alert.alert_key).label} · notification :{" "}
              {operationalAlertNotificationLabel(alert.notification_status).toLowerCase()}
            </li>
          ))}
      </ul>
    </section>
  );
}
