"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import {
  fetchAdminAutoPublication,
  runAdminAutoPublicationActionClient,
} from "@/lib/client-api/admin-auto-publication";
import type { AutoPublicationReviewDecision } from "@/lib/admin-information-agent-auto-publication";

export const AUTO_PUBLICATION_QUERY_KEY = ["admin-information-agent-auto-publication"] as const;
const REVIEW_QUERY_KEY = ["admin-information-agent-review"] as const;

/**
 * Publication automatique des informations reçues (onglet Réglages) : arrêt ou simulation ; le mode
 * automatique est affiché verrouillé, avec ses conditions. Arrêt d'urgence en un geste. Tout arrive mis en
 * forme par le serveur ; chaque changement est tracé en base (qui, quand, ancien et nouveau mode).
 */
export function AdminInformationAgentAutoPublicationPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: AUTO_PUBLICATION_QUERY_KEY,
    queryFn: fetchAdminAutoPublication,
    staleTime: 30_000,
  });
  const run = useMutation({
    mutationFn: runAdminAutoPublicationActionClient,
    onSuccess: (view) => {
      queryClient.setQueryData(AUTO_PUBLICATION_QUERY_KEY, view);
      // Les annotations de l'onglet Réponses suivent le mode.
      void queryClient.invalidateQueries({ queryKey: REVIEW_QUERY_KEY });
      toast.success(`Publication automatique : ${view.modeLabel.toLowerCase()}.`);
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Action impossible"),
  });
  const view = query.data;

  return (
    <section className="rounded-xl border bg-white p-5" aria-labelledby="auto-publication-title">
      <h2 id="auto-publication-title" className="font-semibold">
        Publication automatique des informations reçues
      </h2>
      {/* Toujours affiché, même si la lecture du réglage échoue : l'arrêt ne dépend que du serveur. */}
      <button
        type="button"
        className="admin-button-primary mt-3"
        disabled={run.isPending || view?.mode === "off"}
        onClick={() => run.mutate({ action: "emergency_stop" })}
      >
        Arrêt d’urgence
      </button>
      {query.error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          Réglage indisponible. L’arrêt d’urgence reste possible.
        </p>
      ) : null}
      {view ? (
        <div className="mt-3 space-y-4 text-sm">
          <p>
            Mode : <strong>{view.modeLabel}</strong>
          </p>
          <p className="text-brand-navy/70">
            En simulation, chaque information reçue est examinée par le moteur et l’onglet Réponses
            indique « aurait été publié » ou « relecture », avec les raisons. Rien n’est publié.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="admin-button-secondary"
              disabled={run.isPending || view.mode === "off"}
              onClick={() => run.mutate({ action: "set_mode", mode: "off" })}
            >
              Arrêt
            </button>
            <button
              type="button"
              className="admin-button-secondary"
              disabled={run.isPending || view.mode === "simulation"}
              onClick={() => run.mutate({ action: "set_mode", mode: "simulation" })}
            >
              Simulation
            </button>
            <button
              type="button"
              className="admin-button-secondary"
              disabled
              aria-describedby="auto-publication-lock"
            >
              Automatique (verrouillé)
            </button>
          </div>
          <div id="auto-publication-lock" className="text-brand-navy/70">
            <p className="font-medium">Le mode automatique reste verrouillé jusqu’à :</p>
            <ul className="mt-1 list-inside list-disc">
              {view.lockReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
          <p className="text-brand-navy/70">
            Champs concernés : {view.eligibleFields.join(", ")}. Plafonds : {view.caps.daily} par
            jour, {view.caps.perCase} par dossier.
          </p>
          {view.changes.length ? (
            <details>
              <summary className="cursor-pointer font-medium">Derniers changements de mode</summary>
              <ul className="mt-2 space-y-1">
                {view.changes.map((change, index) => (
                  <li key={`${change.at}-${index}`}>
                    {new Date(change.at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} ·{" "}
                    {change.label}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Décision du moteur affichée à côté d'une information de l'onglet Réponses (mode simulation). */
export function AutoPublicationDecisionNote({
  decision,
}: {
  decision: AutoPublicationReviewDecision | undefined;
}) {
  if (!decision) {
    return (
      <p className="mt-2 text-xs text-brand-navy/55">
        Simulation : décision du moteur pas encore calculée.
      </p>
    );
  }
  return (
    <p
      className={`mt-2 text-xs font-medium ${
        decision.outcome === "would_publish" ? "text-success" : "text-brand-navy/70"
      }`}
    >
      Simulation : {decision.label.toLowerCase()}
      {decision.reasons.length ? ` (${decision.reasons.join(" ; ")})` : ""}.
    </p>
  );
}
