"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { AdminPill } from "@/components/admin/admin-pill";
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
import type { AutopilotPreparedDraft, AutopilotView } from "@/lib/information-agent/autopilot-view";

const BTN = "admin-button-secondary";
const INPUT = "mt-1 block w-28 rounded-lg border bg-white px-2 py-1";
/** Champ pleine largeur, 44 px de haut au moins (cible tactile). */
const FIELD = "mt-1 block min-h-11 w-full rounded-lg border bg-white px-3 py-2 text-sm";
/** Le mode réel a son propre bouton, dans « Mise en service du mode réel ». */
type AutopilotChangeInput = Parameters<typeof runAdminInformationAgentAutopilotActionClient>[0];
const MODES = [
  ["off", "Éteint"],
  ["simulation", "Simulation"],
] as const;
/**
 * Version de l'AIPD proposée à l'attestation : référence de l'AIPD du 23/11/2026, version 1.1, celle qui couvre
 * l'envoi automatique, validée par le propriétaire (document conservé hors du dépôt public, dans son dossier). À
 * changer à chaque nouvelle version de l'AIPD (`docs/runbooks/information-agent.md`, « Pilote automatique »).
 */
const AIPD_VERSION = "AIPD-AGENT-INFO-PILOTE v1.1";
const SIMULATION_TOASTS: Record<AutopilotOnDemandRun["outcome"], string> = {
  finished: "Passage de simulation terminé.",
  time_budget: "Passage de simulation arrêté par la borne de temps.",
  interrupted: "Passage de simulation interrompu.",
};

/**
 * Pilote automatique : changement de mode, passages, compteurs, contrôle de préparation, réglages du
 * pilote, conformité, brouillons prêts à valider, derniers événements et arrêt d’urgence. Désactivé par défaut.
 * Tout arrive mis en forme par le serveur ; chaque changement exige un motif (sauf l’arrêt d’urgence) et est
 * journalisé. Un brouillon prêt à valider s’ouvre dans l’éditeur de l’onglet « À contacter » (`onOpenDraft`), là où
 * il se valide. En mode Simulation, un passage peut être lancé à la main (hors plage horaire) ; son résultat ou son
 * refus s’affiche.
 *
 * Les boutons disent l’action qu’ils font, jamais l’état (P3, 14/11/2026). Tant que le pilote n’est pas en mode
 * réel, le bloc « Mise en service du mode réel » ouvre l’onglet : conditions du contrôle de préparation, attestation
 * de l’AIPD, puis passage en mode réel, chacun avec sa confirmation. En mode réel, il laisse place à l’état « Pilote
 * en mode réel » et au retour en simulation ; l’arrêt d’urgence reste en haut, dans tous les modes. L’article 14
 * est à part, dans « Conformité », comme l’AIPD une fois en mode réel ; chaque action y demande une confirmation
 * explicite (J9 : l’article 14 ne se désactive plus, son délai va de 1 à 90 jours depuis la décision du
 * propriétaire du 14/11/2026 ; la base le refuse aussi).
 */
export function AdminInformationAgentAutopilotPanel({
  onOpenDraft,
}: {
  onOpenDraft?: (draft: AutopilotPreparedDraft) => void;
}) {
  const queryClient = useQueryClient();
  const reasonHintId = useId();
  const liveHintId = useId();
  const [reason, setReason] = useState("");
  const [runOutcome, setRunOutcome] = useState<{ refused: boolean; text: string } | null>(null);
  // Refus du passage en mode réel, tel que le serveur l'a rédigé (double authentification, contrôle).
  const [liveRefusal, setLiveRefusal] = useState<string | null>(null);
  const [cap, setCap] = useState("");
  const [days, setDays] = useState("");
  const query = useQuery(autopilotQuery());
  const run = useMutation({
    mutationFn: runAdminInformationAgentAutopilotActionClient,
    // Chaque action vide son propre motif à l'appel (`change`, `attestAipd`) : attester l'AIPD ne vide pas celui
    // du passage en mode réel.
    onSuccess: (view) => {
      queryClient.setQueryData(QUERY_KEY, view);
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
  const toDo = view ? view.readiness.checks.filter((check) => !check.ok).length : 0;
  const conditionsLabel = view
    ? `${view.readiness.checks.length - toDo} sur ${view.readiness.checks.length} conditions remplies`
    : "";
  // Pourquoi « Passer le pilote en mode réel » est grisé ; la double authentification n'est connue que par le
  // refus du serveur (`liveRefusal`).
  const liveBlockers = [
    reasonMissing ? "motif manquant (8 caractères au moins)" : null,
    view && !view.readiness.ready
      ? toDo > 1
        ? `${toDo} conditions sont « À faire »`
        : "une condition est « À faire »"
      : null,
  ].filter(Boolean);

  /** Changement qui porte le motif commun de l'onglet : il le vide une fois fait. */
  function change(input: AutopilotChangeInput) {
    run.mutate(input, { onSuccess: () => setReason("") });
  }

  function goLive() {
    if (
      !window.confirm(
        "Passer le pilote en mode réel ? Il enverra lui-même de vrais messages aux professionnels, dans la limite des plafonds du jour. Vous pourrez repasser en simulation ou l’arrêter à tout moment. Le changement est journalisé avec votre motif.",
      )
    )
      return;
    setLiveRefusal(null);
    run.mutate(
      { action: "set_mode", mode: "live", reason },
      {
        onSuccess: () => setReason(""),
        onError: (error) => setLiveRefusal(queryErrorMessage(error, "Mode réel refusé.")),
      },
    );
  }

  function attestAipd(version: string, motif: string, done: () => void) {
    run.mutate({ action: "attest_aipd", version, reason: motif }, { onSuccess: done });
  }

  const reasonField = (
    <div>
      <label className="block text-xs font-medium">
        Motif du changement (8 caractères au moins)
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-describedby={reasonMissing ? reasonHintId : undefined}
          className={FIELD}
        />
      </label>
      {reasonMissing ? (
        <p id={reasonHintId} className="mt-1 text-xs text-brand-navy/70">
          Saisissez un motif de 8 caractères au moins pour activer les boutons (l’arrêt d’urgence
          n’en demande pas).
        </p>
      ) : null}
    </div>
  );
  const modeButtons = MODES.map(([mode, label]) => (
    <button
      key={mode}
      type="button"
      className={BTN}
      disabled={!ready || view?.mode === mode}
      onClick={() => change({ action: "set_mode", mode, reason })}
    >
      {label}
    </button>
  ));

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
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p>
                État : <strong>{view.modeLabel}</strong>
              </p>
              <p className="text-brand-navy/70">{view.runs}</p>
            </div>
            <AdminAutopilotEmergencyStop mode={view.mode} />
          </div>
          {view.notice ? (
            <p
              role="alert"
              className={view.notice.tone === "alert" ? "text-danger" : "text-warning"}
            >
              {view.notice.text}
            </p>
          ) : null}
          {view.mode === "live" ? (
            <section
              aria-labelledby="autopilot-live-title"
              className="space-y-3 rounded-lg border-2 border-danger/30 p-3 sm:p-4"
            >
              <h3 id="autopilot-live-title" className="text-base font-semibold">
                Pilote en mode réel
              </h3>
              <p>
                Le pilote envoie lui-même de vrais messages, dans la limite des plafonds du jour.
                Pour revenir en arrière, saisissez un motif puis repassez en simulation. En cas de
                problème, utilisez l’arrêt d’urgence, en haut : il ne demande pas de motif.
              </p>
              {reasonField}
              <div className="flex flex-wrap gap-2">{modeButtons}</div>
              {/* Une condition qui redevient « À faire » (aller-retour expiré) se voit ici. */}
              <details>
                <summary className="flex min-h-11 cursor-pointer items-center font-medium">
                  Conditions du mode réel : {conditionsLabel}
                  {toDo ? `, ${toDo} à faire` : ""}
                </summary>
                <ReadinessChecks checks={view.readiness.checks} />
              </details>
            </section>
          ) : (
            <>
              <section
                aria-labelledby="autopilot-go-live-title"
                className="space-y-5 rounded-lg border-2 border-gold-soft/40 bg-surface-tint/40 p-3 sm:p-4"
              >
                <div>
                  <h3 id="autopilot-go-live-title" className="text-base font-semibold">
                    Mise en service du mode réel
                  </h3>
                  <p className="mt-1">
                    En mode réel, le pilote envoie lui-même de vrais messages aux professionnels.
                    Suivez les trois étapes ci-dessous.
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold">1. Vérifier les conditions</h4>
                  <p className="mt-1">{conditionsLabel}.</p>
                  <ReadinessChecks checks={view.readiness.checks} />
                </div>
                <div>
                  <h4 className="font-semibold">2. Attester l’AIPD</h4>
                  <AipdAttestation
                    label={view.settings.aipdLabel}
                    busy={run.isPending || simulate.isPending}
                    onAttest={attestAipd}
                  />
                </div>
                <div className="space-y-2">
                  <h4 className="font-semibold">3. Passer en mode réel</h4>
                  {reasonField}
                  <button
                    type="button"
                    className="admin-button-primary whitespace-normal"
                    disabled={liveBlockers.length > 0 || run.isPending || simulate.isPending}
                    aria-describedby={liveBlockers.length ? liveHintId : undefined}
                    onClick={goLive}
                  >
                    Passer le pilote en mode réel
                  </button>
                  {liveBlockers.length ? (
                    <p id={liveHintId} className="text-xs text-brand-navy/70">
                      Bouton inactif : {liveBlockers.join(" ; ")}.
                    </p>
                  ) : null}
                  {liveRefusal ? (
                    <p role="alert" className="text-danger">
                      {liveRefusal}
                    </p>
                  ) : null}
                </div>
              </section>
              <div className="space-y-2">
                <p className="font-medium">Autres changements de mode</p>
                <p className="text-xs text-brand-navy/70">Avec le motif saisi à l’étape 3.</p>
                <div className="flex flex-wrap gap-2">{modeButtons}</div>
              </div>
            </>
          )}
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
                    change({
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
                    change({
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
                      change({
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
                        change({
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
              {/* Un seul champ d'attestation à la fois : ici en mode réel, sinon à l'étape 2 en haut. */}
              {view.mode === "live" ? (
                <AipdAttestation
                  label={view.settings.aipdLabel}
                  busy={run.isPending || simulate.isPending}
                  onAttest={attestAipd}
                />
              ) : (
                <p>
                  AIPD : <strong>{view.settings.aipdLabel}</strong>. Pour l’attester, utilisez
                  l’étape 2 de « Mise en service du mode réel », en haut.
                </p>
              )}
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

/** Conditions du contrôle de préparation : « OK » ou « À faire » en toutes lettres, avec l'action à mener. */
function ReadinessChecks({ checks }: { checks: AutopilotView["readiness"]["checks"] }) {
  return (
    <ul className="mt-2 divide-y divide-brand-navy/10 rounded-lg border bg-white px-3">
      {checks.map((check) => (
        <li
          key={check.label}
          className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-3"
        >
          <span className="w-20 shrink-0">
            <AdminPill tone={check.ok ? "success" : "warning"}>
              {check.ok ? "OK" : "À faire"}
            </AdminPill>
          </span>
          <div className="min-w-0 break-words">
            <p className="font-medium">{check.label}</p>
            {check.action ? <p>{check.action}</p> : null}
            <p className="text-xs text-ink-soft">{check.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * Attestation de l'AIPD : version pré-remplie, motif propre à l'attestation (elle précède le motif du passage en
 * mode réel), confirmation explicite. Rendue à un seul endroit selon le mode (mise en service ou « Conformité »).
 */
function AipdAttestation({
  label,
  busy,
  onAttest,
}: {
  label: string;
  busy: boolean;
  onAttest: (version: string, reason: string, done: () => void) => void;
}) {
  const hintId = useId();
  const [version, setVersion] = useState(AIPD_VERSION);
  const [reason, setReason] = useState("");
  const trimmed = version.trim();
  const blockers = [
    trimmed ? null : "version manquante",
    reason.trim().length < 8 ? "motif manquant (8 caractères au moins)" : null,
  ].filter(Boolean);

  return (
    <div className="mt-1 space-y-2">
      <p>
        AIPD : <strong>{label}</strong>
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs font-medium">
          Version de l’AIPD
          <input
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            className={FIELD}
          />
        </label>
        <label className="block text-xs font-medium">
          Motif de l’attestation (8 caractères au moins)
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={FIELD}
          />
        </label>
      </div>
      <button
        type="button"
        className={`${BTN} whitespace-normal`}
        disabled={busy || blockers.length > 0}
        aria-describedby={blockers.length ? hintId : undefined}
        onClick={() => {
          if (
            !window.confirm(
              `Attester l’AIPD, version « ${trimmed} » ? Cette attestation lève l’un des verrous du mode réel : ne la donnez que pour une AIPD rédigée, signée et versée au dossier.`,
            )
          )
            return;
          onAttest(trimmed, reason, () => setReason(""));
        }}
      >
        Attester l’AIPD
      </button>
      {blockers.length ? (
        <p id={hintId} className="text-xs text-brand-navy/70">
          Bouton inactif : {blockers.join(" ; ")}.
        </p>
      ) : null}
    </div>
  );
}
