"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import {
  attestAdminInformationAgentRoundtripClient,
  fetchAdminInformationAgentOperations,
} from "@/lib/client-api";

const QUERY_KEY = ["admin-information-agent-operations"] as const;
const TONES = {
  ok: "text-success",
  warn: "text-warning",
  alert: "text-danger",
  plain: "",
} as const;

/**
 * Indicateurs d’exploitation (30 jours) et vérification de l’aller-retour de réception. Toutes les valeurs
 * arrivent mises en forme par le serveur, avec leur effectif : « 1 sur 12 », jamais un pourcentage seul.
 */
export function AdminInformationAgentOperationsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAdminInformationAgentOperations,
    staleTime: 60_000,
  });
  const attest = useMutation({
    mutationFn: attestAdminInformationAgentRoundtripClient,
    onSuccess: (view) => {
      queryClient.setQueryData(QUERY_KEY, view);
      toast.success("Vérification de l’aller-retour enregistrée.");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action impossible"),
  });
  const view = query.data;

  return (
    <section className="rounded-xl border bg-white p-5" aria-labelledby="agent-operations-title">
      <h2 id="agent-operations-title" className="font-semibold">
        Suivi des envois et de la réception
      </h2>
      {query.isPending ? (
        <p role="status" className="mt-2 text-sm">
          Chargement des indicateurs…
        </p>
      ) : null}
      {query.error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          Indicateurs indisponibles.
        </p>
      ) : null}
      {view ? (
        <>
          <p className="mt-1 text-xs text-brand-navy/55">{view.windowLabel}</p>
          <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {view.rows.map((row) => (
              <div key={row.key} className="flex justify-between gap-3 border-b py-1">
                <dt className="text-brand-navy/70">{row.label}</dt>
                <dd className={`text-right font-medium ${TONES[row.tone]}`}>{row.value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-surface-tint p-3 text-sm">
            <p className={view.roundtrip.stale ? "text-warning" : "text-success"}>
              Aller-retour de réception : {view.roundtrip.label}
            </p>
            <button
              type="button"
              className="admin-button-secondary"
              disabled={attest.isPending}
              onClick={() => attest.mutate()}
            >
              J’ai vérifié l’aller-retour réel
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}
