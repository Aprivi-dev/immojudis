"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchPipelineStatus, setPipelineSourceEnabled } from "@/lib/client-api";
import { pipelineSourceStatus } from "@/lib/pipeline-source-status";
function date(value: string | null) {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("fr-FR")
    : "Non établie";
}
export function AdminPipelinePanel() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["admin-pipeline"],
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
      await client.invalidateQueries({ queryKey: ["admin-pipeline"] });
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
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="p-2">Source</th>
              <th className="p-2">État</th>
              <th className="p-2">Inventaire complet</th>
              <th className="p-2">Publication complète</th>
              <th className="p-2">Fiches vérifiées à temps</th>
              <th className="p-2">Planification</th>
            </tr>
          </thead>
          <tbody>
            {data.sources.map((source) => {
              const metrics = data.observations.find(
                (item) => item.source_name === source.source_name,
              )?.metrics;
              const ratio = metrics?.freshness_ratio;
              const status = pipelineSourceStatus(source);
              return (
                <tr key={source.source_name} className="border-t align-top">
                  <th className="p-2 font-medium">{source.source_name}</th>
                  <td className="p-2">
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
                  <td className="p-2">
                    {date(source.last_inventory_complete_at)}
                    {source.coverage?.scoped_inventory_complete ? (
                      <p className="max-w-xs text-xs">
                        Périmètre accessible complet ; archives sans lien exclues.
                      </p>
                    ) : null}
                  </td>
                  <td className="p-2">
                    {date(source.last_publication_complete_at)}
                    {typeof source.coverage?.publication_published === "number" ? (
                      <p className="text-xs">
                        Dernier passage : {source.coverage.publication_published} publiées,{" "}
                        {source.coverage.publication_pending ?? 0} à finaliser.
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
                  <td className="p-2">
                    {typeof ratio === "number"
                      ? `${Math.round(ratio * 100)} % (${metrics?.fresh_listings}/${metrics?.active_listings})`
                      : "Non mesuré"}
                  </td>
                  <td className="p-2">
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
              {alert.alert_key} — notification : {alert.notification_status}
            </li>
          ))}
      </ul>
    </section>
  );
}
