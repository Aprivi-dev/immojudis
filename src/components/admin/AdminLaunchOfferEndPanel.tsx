"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AdminPanel } from "@/components/admin/AdminShell";
import {
  fetchAdminLaunchOfferEnd,
  postAdminLaunchOfferEnd,
  type LaunchOfferEndSendResult,
} from "@/lib/client-api/admin";
import { toast } from "@/lib/toast";

export const LAUNCH_OFFER_END_QUERY_KEY = ["admin-launch-offer-end"] as const;

/**
 * Fin de l'offre de lancement (n° 74) : la date annoncée, les comptes concernés, l'aperçu du préavis,
 * l'essai et l'envoi. Rien ne part tout seul : l'envoi demande un clic et une confirmation, et la date
 * ne coupe pas l'offre (bloc « Offre de lancement » ci-dessus). Procédure : docs/runbooks/offre-de-lancement.md.
 */
export function AdminLaunchOfferEndPanel() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const query = useQuery({
    queryKey: LAUNCH_OFFER_END_QUERY_KEY,
    queryFn: fetchAdminLaunchOfferEnd,
    staleTime: 15_000,
  });
  const onError = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : "Action impossible");
  const saveDate = useMutation({
    mutationFn: (endsOn: string | null) => postAdminLaunchOfferEnd({ action: "set-date", endsOn }),
    onSuccess: (state) => {
      queryClient.setQueryData(LAUNCH_OFFER_END_QUERY_KEY, state);
      setDraft(null);
      toast.success("Date de fin enregistrée. L’offre reste active jusqu’à sa coupure.");
    },
    onError,
  });
  const test = useMutation({
    mutationFn: () => postAdminLaunchOfferEnd<{ sentTo: string }>({ action: "test" }),
    onSuccess: (result) => toast.success(`Message d’essai envoyé à ${result.sentTo}.`),
    onError,
  });
  const send = useMutation({
    mutationFn: (endsOn: string) =>
      postAdminLaunchOfferEnd<LaunchOfferEndSendResult>({ action: "send", endsOn, confirm: true }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: LAUNCH_OFFER_END_QUERY_KEY });
      toast.success(
        `${result.sent} préavis envoyé${result.sent > 1 ? "s" : ""}` +
          (result.failed ? `, ${result.failed} en échec (à relancer)` : "") +
          (result.skipped ? `, ${result.skipped} ignoré${result.skipped > 1 ? "s" : ""}` : "") +
          `. Il reste ${result.remaining} compte${result.remaining > 1 ? "s" : ""}` +
          (result.stoppedEarly ? " : relancez l’envoi pour la suite." : "."),
      );
    },
    onError,
  });

  const state = query.data;
  const audience = state?.audience ?? null;
  const busy = saveDate.isPending || test.isPending || send.isPending;
  const batch = audience ? Math.min(audience.recipients, state?.batchSize ?? 0) : 0;
  const dateValue = draft ?? state?.endsOn ?? "";

  function sendBatch() {
    if (!state?.endsOn || busy || batch === 0 || state.blocker) return;
    if (
      !window.confirm(
        `Envoyer le préavis de fin de l’offre (fin prévue le ${state.endsOnLabel}) à ${batch} compte${batch > 1 ? "s" : ""} ? Chaque compte ne le reçoit qu’une fois pour cette date.`,
      )
    ) {
      return;
    }
    send.mutate(state.endsOn);
  }

  return (
    <AdminPanel className="mb-6 p-5">
      <h2 className="text-xl font-semibold">Fin de l’offre de lancement : préavis</h2>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-navy/65">
        Les textes publics promettent un préavis par email. La date ci-dessous est celle que dira le
        message ; elle ne coupe pas l’offre. Rien n’est envoyé automatiquement.
      </p>
      {query.isPending ? (
        <p className="mt-3 text-sm">Chargement…</p>
      ) : query.isError || !state ? (
        <div role="alert" className="mt-3 text-sm text-red-700">
          <p>{query.error instanceof Error ? query.error.message : "Préavis indisponible."}</p>
          <button
            type="button"
            className="admin-button-secondary mt-2"
            onClick={() => void query.refetch()}
          >
            Réessayer
          </button>
        </div>
      ) : (
        <>
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (dateValue && !busy) saveDate.mutate(dateValue);
            }}
          >
            <label className="text-sm font-semibold" htmlFor="launch-offer-end-date">
              Date de fin annoncée
              <input
                id="launch-offer-end-date"
                type="date"
                className="form-input mt-1 block min-h-11"
                value={dateValue}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="admin-button-secondary"
              disabled={!dateValue || dateValue === state.endsOn || busy}
            >
              Enregistrer la date
            </button>
            {state.endsOn ? (
              <button
                type="button"
                className="admin-button-secondary"
                disabled={busy}
                onClick={() => saveDate.mutate(null)}
              >
                Effacer
              </button>
            ) : null}
          </form>
          <p className="mt-2 text-sm" data-testid="launch-offer-end-status">
            {state.endsOn
              ? `Fin annoncée le ${state.endsOnLabel} (dans ${state.daysLeft} jour${(state.daysLeft ?? 0) > 1 ? "s" : ""}). `
              : "Aucune date annoncée. "}
            {state.blocker ?? "Le préavis peut être envoyé."}
          </p>
          {audience ? (
            <p className="mt-2 text-sm text-brand-navy/70" data-testid="launch-offer-end-audience">
              <strong>{audience.recipients}</strong> compte{audience.recipients > 1 ? "s" : ""} à
              prévenir sur {audience.accounts} qui n’ont l’accès Analyse que grâce à l’offre ;{" "}
              {audience.notified} déjà prévenu{audience.notified > 1 ? "s" : ""},{" "}
              {audience.optedOut} désinscrit{audience.optedOut > 1 ? "s" : ""}.
            </p>
          ) : null}
          {audience && audience.needsReview > 0 ? (
            <p role="status" className="mt-2 text-sm text-amber-800">
              {audience.needsReview} envoi{audience.needsReview > 1 ? "s" : ""} à vérifier : essais
              épuisés ou vieux de plus de 23 h. Consulter le journal d’envoi de Resend avant de
              relancer.
            </p>
          ) : null}
          {state.configured ? null : (
            <p role="status" className="mt-2 text-sm text-amber-800">
              Envoi d’emails non configuré sur ce serveur (manque : {state.missing.join(", ")}).
            </p>
          )}
          {state.preview ? (
            <details className="mt-3 rounded-lg bg-gold/10 p-3 text-sm leading-6">
              <summary className="cursor-pointer font-semibold">Aperçu du message</summary>
              <p className="mt-2 font-semibold">{state.preview.subject}</p>
              <pre className="mt-2 whitespace-pre-wrap font-sans">{state.preview.text}</pre>
            </details>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="admin-button-secondary"
              disabled={!state.configured || !state.endsOn || busy}
              onClick={() => test.mutate()}
            >
              {test.isPending ? "Envoi…" : "M’envoyer un essai"}
            </button>
            <button
              type="button"
              className="admin-button-primary"
              disabled={!state.configured || batch === 0 || Boolean(state.blocker) || busy}
              onClick={sendBatch}
            >
              {send.isPending
                ? "Envoi en cours…"
                : `Envoyer le préavis à ${batch} compte${batch > 1 ? "s" : ""}`}
            </button>
          </div>
        </>
      )}
    </AdminPanel>
  );
}
