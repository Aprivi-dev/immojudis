"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import { toast } from "@/lib/toast";
import { AdminPanel } from "@/components/admin/AdminShell";
import {
  fetchAdminOfferOpeningAudience,
  sendAdminOfferOpeningBatch,
  sendAdminOfferOpeningTest,
} from "@/lib/client-api";

export const OFFER_OPENING_AUDIENCE_QUERY_KEY = ["admin-offer-opening-audience"] as const;

/**
 * « Prévenir la liste d'attente » : les personnes qui ont demandé à être prévenues de l'ouverture de
 * l'offre Analyse (`offer_opening_notifications`). Nombre de destinataires, aperçu du message, envoi
 * d'essai à l'administrateur, puis envoi par lots de 200 au plus. Chaque personne n'est prévenue
 * qu'une fois (`notified_at`). À n'utiliser que quand la souscription est réellement ouverte : le
 * message renvoie vers /offres. Procédure : docs/runbooks/offre-de-lancement.md.
 */
export function AdminOfferOpeningPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: OFFER_OPENING_AUDIENCE_QUERY_KEY,
    queryFn: fetchAdminOfferOpeningAudience,
    staleTime: 15_000,
  });
  const test = useMutation({
    mutationFn: sendAdminOfferOpeningTest,
    onSuccess: (result) => toast.success(`Message d’essai envoyé à ${result.sentTo}.`),
    onError: (error) => toast.error(error instanceof Error ? error.message : "Envoi impossible"),
  });
  const send = useMutation({
    mutationFn: sendAdminOfferOpeningBatch,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: OFFER_OPENING_AUDIENCE_QUERY_KEY });
      toast.success(
        `${result.sent} message${result.sent > 1 ? "s" : ""} envoyé${result.sent > 1 ? "s" : ""}` +
          (result.failed ? `, ${result.failed} en échec (à relancer)` : "") +
          (result.skipped ? `, ${result.skipped} ignoré${result.skipped > 1 ? "s" : ""}` : "") +
          `. Il reste ${result.remaining} destinataire${result.remaining > 1 ? "s" : ""}` +
          (result.stoppedEarly ? " : relancez l’envoi pour la suite." : "."),
      );
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Envoi impossible"),
  });

  const audience = query.data;
  const busy = test.isPending || send.isPending;
  const batch = audience ? Math.min(audience.recipients, audience.batchSize) : 0;

  function sendBatch() {
    if (!audience || busy || audience.recipients === 0) return;
    // Un envoi réel ne se rattrape pas : confirmation explicite, avec le nombre de destinataires.
    if (
      !window.confirm(
        `Envoyer le message d’ouverture à ${batch} personne${batch > 1 ? "s" : ""} de la liste d’attente ? Chaque personne ne le reçoit qu’une fois. Vérifiez d’abord que la souscription est réellement ouverte.`,
      )
    ) {
      return;
    }
    send.mutate();
  }

  return (
    <AdminPanel className="mb-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-3xl">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold-text">
            <Mail className="size-4" aria-hidden />
            Liste d’attente
          </div>
          <h2 className="mt-2 text-xl font-semibold">Prévenir la liste d’attente</h2>
          {query.isPending ? (
            <p className="mt-2 text-sm text-brand-navy/65">Chargement de la liste d’attente…</p>
          ) : query.isError || !audience ? (
            <p role="alert" className="mt-2 text-sm text-red-700">
              Liste d’attente indisponible.
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm leading-6 text-brand-navy/65" data-testid="opening-count">
                <strong className="text-brand-navy">{audience.recipients}</strong> destinataire
                {audience.recipients > 1 ? "s" : ""} actif{audience.recipients > 1 ? "s" : ""}{" "}
                (demande active, jamais prévenu). {audience.alreadyNotified} déjà prévenu
                {audience.alreadyNotified > 1 ? "s" : ""}. Envoi par lots de {audience.batchSize} au
                plus ; une personne n’est jamais prévenue deux fois.
              </p>
              {audience.configured ? null : (
                <p role="status" className="mt-2 text-sm text-amber-800">
                  Envoi d’emails non configuré sur ce serveur (manque :{" "}
                  {audience.missing.join(", ")}
                  ).
                </p>
              )}
              <details className="mt-3 rounded-lg bg-gold/10 p-3 text-sm leading-6">
                <summary className="cursor-pointer font-semibold">Aperçu du message</summary>
                <p className="mt-2 font-semibold" data-testid="opening-preview-subject">
                  {audience.preview.subject}
                </p>
                <pre
                  className="mt-2 whitespace-pre-wrap font-sans"
                  data-testid="opening-preview-text"
                >
                  {audience.preview.text}
                </pre>
                <p className="mt-2 text-xs text-brand-navy/60">
                  Texte sobre, sans prix : il renvoie vers la page Offres. À faire relire avant le
                  premier envoi réel.
                </p>
              </details>
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {query.isError ? (
            <button
              type="button"
              className="admin-button-secondary"
              onClick={() => void query.refetch()}
            >
              Réessayer
            </button>
          ) : (
            <>
              <button
                type="button"
                className="admin-button-secondary"
                disabled={!audience?.configured || busy}
                onClick={() => test.mutate()}
              >
                {test.isPending ? "Envoi…" : "M’envoyer un essai"}
              </button>
              <button
                type="button"
                className="admin-button-primary"
                disabled={!audience?.configured || audience.recipients === 0 || busy}
                onClick={sendBatch}
              >
                {send.isPending
                  ? "Envoi en cours…"
                  : `Envoyer à ${batch} personne${batch > 1 ? "s" : ""}`}
              </button>
            </>
          )}
        </div>
      </div>
    </AdminPanel>
  );
}
