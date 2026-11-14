"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { AdminAutopilotEmergencyStop } from "@/components/admin/AdminAutopilotEmergencyStop";
import { toast } from "@/lib/toast";
import {
  AUTOPILOT_QUERY_KEY as QUERY_KEY,
  autopilotQuery,
} from "@/components/admin/information-agent-queries";
import {
  runAdminInformationAgentAutopilotActionClient,
  runAdminInformationAgentAutopilotSimulationClient,
} from "@/lib/client-api";
import type { AutopilotOnDemandRun } from "@/lib/admin-information-agent-autopilot";
import type { AutopilotPreparedDraft } from "@/lib/information-agent/autopilot-view";

const BTN = "admin-button-secondary";
const INPUT = "mt-1 block w-28 rounded-lg border bg-white px-2 py-1";
const MODES = [
  ["off", "Éteint"],
  ["simulation", "Simulation"],
  ["live", "Réel"],
] as const;
const SIMULATION_TOASTS: Record<AutopilotOnDemandRun["outcome"], string> = {
  finished: "Passage de simulation terminé.",
  time_budget: "Passage de simulation arrêté par la borne de temps.",
  interrupted: "Passage de simulation interrompu.",
};

/**
 * Pilote automatique : interrupteur à trois états, passages, compteurs, contrôle de préparation, réglages du
 * pilote, conformité, brouillons prêts à valider, derniers événements et arrêt d’urgence. Désactivé par défaut.
 * Tout arrive mis en forme par le serveur ; chaque changement exige un motif (sauf l’arrêt d’urgence) et est
 * journalisé. Un brouillon prêt à valider s’ouvre dans l’éditeur de l’onglet « À contacter » (`onOpenDraft`), là où
 * il se valide. En mode Simulation, un passage peut être lancé à la main (hors plage horaire) ; son résultat ou son
 * refus s’affiche.
 *
 * Les boutons disent l’action qu’ils font, jamais l’état (P3, 14/11/2026). L’article 14 et l’AIPD sont à part,
 * dans « Conformité », et chaque action y demande une confirmation explicite (J9 : l’article 14 ne se désactive
 * plus, son délai va de 1 à 90 jours depuis la décision du propriétaire du 14/11/2026 ; la base le refuse aussi).
 */
export function AdminInformationAgentAutopilotPanel({
  onOpenDraft,
}: {
  onOpenDraft?: (draft: AutopilotPreparedDraft) => void;
}) {
  const queryClient = useQueryClient();
  const reasonHintId = useId();
  const [reason, setReason] = useState("");
  const [runOutcome, setRunOutcome] = useState<{ refused: boolean; text: string } | null>(null);
  const [cap, setCap] = useState("");
  const [days, setDays] = useState("");
  const [aipd, setAipd] = useState("");
  const query = useQuery(autopilotQuery());
  const run = useMutation({
    mutationFn: runAdminInformationAgentAutopilotActionClient,
    onSuccess: (view) => {
      queryClient.setQueryData(QUERY_KEY, view);
      setReason("");
      toast.success("Pilote automatique mis à jour.");
    },
    onError: (error) => toast.error(queryErrorMessage(error, "Action impossible")),
  });
  // Passage lancé à la main : la réponse ne porte que son résultat ; l'état du pilote est relu ensuite.
  const simulate = useMutation({
    mutationFn: (motif: string) => runAdminInformationAgentAutopilotSimulationClient(motif),
    onMutate: () => setRunOutcome(null),
    onSuccess: ({ onDemandRun }) => {
      setReason("");
      setRunOutcome({ refused: false, text: onDemandRun.text });
      toast.success(SIMULATION_TOASTS[onDemandRun.outcome]);
    },
    onError: (error) => {
      const text = queryErrorMessage(error, "Passage impossible");
      // 504 : le délai des routes admin est dépassé et le passage a pu aboutir : une information, pas un refus.
      if ((error as { status?: unknown }).status === 504) {
        setRunOutcome({ refused: false, text });
        toast.info(text);
        return;
      }
      setRunOutcome({ refused: true, text });
      toast.error(text);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  const view = query.data;
  const reasonMissing = reason.trim().length < 8;
  const ready = !reasonMissing && !run.isPending && !simulate.isPending;
  const daysValue = Number(days);
  // RÈGLE LIÉE : 1 à 90 jours, comme `AUTOPILOT_ART14_MAX_DAYS` (serveur) et la contrainte de la base.
  const daysValid = Number.isInteger(daysValue) && daysValue >= 1 && daysValue <= 90;

  return (
    <section className="rounded-xl border bg-white p-5" aria-labelledby="autopilot-title">
      <h2 id="autopilot-title" className="font-semibold">
        Pilote automatique
      </h2>
      {query.error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          Pilote indisponible.
        </p>
      ) : null}
      {view ? (
        <div className="mt-3 space-y-4 text-sm">
          <div>
            <p>
              État : <strong>{view.modeLabel}</strong>
            </p>
            <p className="text-brand-navy/70">{view.runs}</p>
          </div>
          {view.notice ? (
            <p
              role="alert"
              className={view.notice.tone === "alert" ? "text-danger" : "text-warning"}
            >
              {view.notice.text}
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1 text-xs font-medium">
              Motif du changement (8 caractères au moins)
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                aria-describedby={reasonMissing ? reasonHintId : undefined}
                className="mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm"
              />
            </label>
            {MODES.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={BTN}
                disabled={!ready || view.mode === mode}
                onClick={() => run.mutate({ action: "set_mode", mode, reason })}
              >
                {label}
              </button>
            ))}
            <AdminAutopilotEmergencyStop mode={view.mode} />
            {reasonMissing ? (
              <p id={reasonHintId} className="basis-full text-xs text-brand-navy/70">
                Saisissez un motif de 8 caractères au moins pour activer les boutons (l’arrêt
                d’urgence n’en demande pas).
              </p>
            ) : null}
          </div>
          {view.mode === "simulation" || runOutcome ? (
            <div className="flex flex-wrap items-center gap-2">
              {view.mode === "simulation" ? (
                <button
                  type="button"
                  className={BTN}
                  disabled={!ready}
                  onClick={() => simulate.mutate(reason)}
                >
                  Lancer un passage de simulation
                </button>
              ) : null}
              {runOutcome ? (
                <p
                  role={runOutcome.refused ? "alert" : "status"}
                  className={runOutcome.refused ? "text-danger" : "text-brand-navy/80"}
                >
                  {runOutcome.text}
                </p>
              ) : null}
            </div>
          ) : null}
          <dl className="grid gap-x-6 sm:grid-cols-2">
            {view.counters.map((counter) => (
              <div key={counter.label} className="flex justify-between gap-3 border-b py-1">
                <dt className="text-brand-navy/70">{counter.label}</dt>
                <dd className="font-medium">{counter.value}</dd>
              </div>
            ))}
          </dl>
          <details>
            <summary className="cursor-pointer font-medium">
              Contrôle de préparation au mode réel :{" "}
              {view.readiness.ready ? "satisfait" : "non satisfait"}
            </summary>
            <ul className="mt-2 space-y-1">
              {view.readiness.checks.map((check) => (
                <li key={check.label} className={check.ok ? "text-success" : "text-danger"}>
                  {check.ok ? "Oui" : "Non"} · {check.label}{" "}
                  <span className="text-brand-navy/60">({check.detail})</span>
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary className="cursor-pointer font-medium">Réglages du pilote</summary>
            <div className="mt-2 space-y-3 text-xs">
              <div className="flex flex-wrap items-end gap-2">
                <label>
                  Plafond par jour
                  <input
                    value={cap}
                    onChange={(event) => setCap(event.target.value)}
                    placeholder={String(view.settings.capTotalOverride ?? "phase")}
                    className={INPUT}
                  />
                </label>
                <button
                  type="button"
                  className={BTN}
                  disabled={!ready || !cap}
                  onClick={() =>
                    run.mutate({
                      action: "update_settings",
                      reason,
                      changes: { capTotalOverride: Number(cap) },
                    })
                  }
                >
                  Enregistrer le plafond
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <p>
                  Adresses Licitor décodées :{" "}
                  <strong>
                    {view.settings.allowLicitorDecoded ? "ouvertes au pilote" : "fermées au pilote"}
                  </strong>
                </p>
                <button
                  type="button"
                  className={BTN}
                  disabled={!ready}
                  onClick={() =>
                    run.mutate({
                      action: "update_settings",
                      reason,
                      changes: { allowLicitorDecoded: !view.settings.allowLicitorDecoded },
                    })
                  }
                >
                  {view.settings.allowLicitorDecoded
                    ? "Fermer les adresses Licitor décodées"
                    : "Ouvrir les adresses Licitor décodées"}
                </button>
              </div>
            </div>
          </details>
          <details>
            <summary className="cursor-pointer font-medium">Conformité (article 14, AIPD)</summary>
            <div className="mt-2 space-y-3 text-xs">
              <div className="space-y-2">
                <p>
                  Article 14 : <strong>{view.settings.art14Label}</strong>
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <label>
                    Délai en jours
                    <input
                      inputMode="numeric"
                      value={days}
                      onChange={(event) => setDays(event.target.value)}
                      placeholder={String(view.settings.art14MaxAgeDays)}
                      className={INPUT}
                    />
                  </label>
                  <button
                    type="button"
                    className={BTN}
                    disabled={!ready || !daysValid}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `Passer le délai d’information de l’article 14 de ${view.settings.art14MaxAgeDays} à ${daysValue} jours ? Le pilote n’écrira qu’aux adresses relevées depuis ${daysValue} jours au plus, ou aux personnes déjà informées. Le changement est journalisé avec votre motif.`,
                        )
                      )
                        return;
                      run.mutate({
                        action: "update_settings",
                        reason,
                        changes: { art14MaxAgeDays: daysValue },
                      });
                    }}
                  >
                    Modifier le délai de l’article 14
                  </button>
                  {view.settings.art14RuleEnabled ? null : (
                    <button
                      type="button"
                      className={BTN}
                      disabled={!ready}
                      onClick={() => {
                        if (
                          !window.confirm(
                            "Rétablir la règle de l’article 14 ? Elle ne pourra plus être désactivée.",
                          )
                        )
                          return;
                        run.mutate({
                          action: "update_settings",
                          reason,
                          changes: { art14RuleEnabled: true },
                        });
                      }}
                    >
                      Rétablir la règle de l’article 14
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <p>
                  AIPD : <strong>{view.settings.aipdLabel}</strong>
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <label>
                    Version de l’AIPD
                    <input
                      value={aipd}
                      onChange={(event) => setAipd(event.target.value)}
                      className={INPUT}
                    />
                  </label>
                  <button
                    type="button"
                    className={BTN}
                    disabled={!ready || !aipd.trim()}
                    onClick={() => {
                      const version = aipd.trim();
                      if (
                        !window.confirm(
                          `Attester l’AIPD, version « ${version} » ? Cette attestation lève l’un des verrous du mode réel : ne la donnez que pour une AIPD rédigée, signée et versée au dossier.`,
                        )
                      )
                        return;
                      run.mutate({ action: "attest_aipd", version, reason });
                    }}
                  >
                    Attester l’AIPD
                  </button>
                </div>
              </div>
            </div>
          </details>
          <div>
            <p className="font-medium">{view.ready.label}</p>
            {view.ready.notice ? <p className="text-warning">{view.ready.notice}</p> : null}
            <ul className="mt-1 list-inside list-disc text-brand-navy/70">
              {view.ready.items.map((item) => (
                <li key={item.missionId}>
                  {onOpenDraft ? (
                    <button
                      type="button"
                      className="text-left font-medium text-gold-text underline"
                      onClick={() => onOpenDraft(item)}
                    >
                      {item.label}
                    </button>
                  ) : (
                    item.label
                  )}
                </li>
              ))}
            </ul>
          </div>
          <details>
            <summary className="cursor-pointer font-medium">Derniers événements</summary>
            <ul className="mt-2 space-y-1">
              {view.events.map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  {event.at} · {event.label} {event.detail}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </section>
  );
}
