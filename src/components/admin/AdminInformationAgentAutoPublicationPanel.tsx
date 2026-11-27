"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { REVIEW_QUERY_KEY } from "@/components/admin/information-agent-queries";
import { formatShortDateTime } from "@/lib/format/dates";
import { toast } from "@/lib/toast";
import {
  fetchAdminAutoPublication,
  runAdminAutoPublicationActionClient,
} from "@/lib/client-api/admin-auto-publication";
import type { AutoPublicationReviewDecision } from "@/lib/admin-information-agent-auto-publication";

const AUTO_PUBLICATION_QUERY_KEY = ["admin-information-agent-auto-publication"] as const;

/**
 * Publication automatique des informations reçues (onglet Réglages) : arrêt, simulation ou automatique (étape 6,
 * décision du propriétaire du 27/11/2026). Le passage en automatique demande une confirmation explicite. Arrêt
 * d'urgence en un geste. Tout arrive mis en forme par le serveur ; chaque changement est tracé en base (qui,
 * quand, ancien et nouveau mode).
 */
export function AdminInformationAgentAutoPublicationPanel() {
  const queryClient = useQueryClient();
  const [autoConfirmed, setAutoConfirmed] = useState(false);
  const query = useQuery({
    queryKey: AUTO_PUBLICATION_QUERY_KEY,
    queryFn: fetchAdminAutoPublication,
    staleTime: 30_000,
  });
  const run = useMutation({
    mutationFn: runAdminAutoPublicationActionClient,
    onSuccess: (view) => {
      setAutoConfirmed(false);
      queryClient.setQueryData(AUTO_PUBLICATION_QUERY_KEY, view);
      // Les annotations de l'onglet Réponses suivent le mode.
      void queryClient.invalidateQueries({ queryKey: REVIEW_QUERY_KEY });
      toast.success(`Publication automatique : ${view.modeLabel.toLowerCase()}.`);
    },
    onError: (error) => toast.error(queryErrorMessage(error, "Action impossible")),
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
            Chaque information reçue passe les contrôles de sécurité (réponse authentifiée de
            l’avocat poursuivant, aucune opposition ni contradiction), puis l’IA (Claude Haiku)
            confirme ou non la valeur. En simulation, l’onglet Réponses indique « aurait été publié
            » ou « à relire », avec les raisons, et rien n’est publié. En automatique, une
            information confirmée est publiée sur la fiche sans relecture humaine ; elle se retire
            depuis les observations de la vente.
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
              disabled={run.isPending || view.mode === "auto" || !autoConfirmed}
              aria-describedby="auto-publication-confirm"
              onClick={() => run.mutate({ action: "set_mode", mode: "auto" })}
            >
              Automatique
            </button>
          </div>
          {view.mode === "auto" ? null : (
            <label id="auto-publication-confirm" className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={autoConfirmed}
                onChange={(event) => setAutoConfirmed(event.target.checked)}
              />
              <span>
                Je confirme : en mode automatique, les informations confirmées par l’IA sont
                publiées sur les fiches sans relecture humaine.
              </span>
            </label>
          )}
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
                    {formatShortDateTime(change.at)} · {change.label}
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

/**
 * Décision du moteur affichée à côté d'une information de l'onglet Réponses : « Simulation : … » en simulation,
 * « Publié automatiquement le … » ou « À relire (raisons) » en automatique.
 */
export function AutoPublicationDecisionNote({
  decision,
  simulation,
}: {
  decision: AutoPublicationReviewDecision | undefined;
  simulation: boolean;
}) {
  const prefix = simulation ? "Simulation : " : "";
  if (!decision) {
    return (
      <p className="mt-2 text-xs text-ink-soft">{prefix}décision du moteur pas encore calculée.</p>
    );
  }
  const reasons = [
    ...decision.reasons,
    ...(decision.arbiterReason ? [`motif de l’IA : ${decision.arbiterReason}`] : []),
  ];
  const label = simulation ? decision.label.toLowerCase() : decision.label;
  return (
    <p
      className={`mt-2 text-xs font-medium ${
        decision.outcome === "review" ? "text-brand-navy/70" : "text-success"
      }`}
    >
      {prefix}
      {label}
      {decision.decidedAt
        ? `${simulation ? "," : ""} le ${formatShortDateTime(decision.decidedAt, "date illisible")}`
        : ""}
      {reasons.length ? ` (${reasons.join(" ; ")})` : ""}.
    </p>
  );
}
