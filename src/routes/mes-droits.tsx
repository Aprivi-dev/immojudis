"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { useState } from "react";
import { toast } from "sonner";
import { createFileRoute, Link } from "@/lib/router-compat";
import { createPrivacyRequestClient, fetchPrivacyRequests } from "@/lib/client-api";
import type { PrivacyRequestType } from "@/lib/privacy-requests";

export const Route = createFileRoute("/mes-droits")({
  head: () => ({
    meta: [
      { title: "Mes droits — Immojudis" },
      {
        name: "description",
        content: "Exercer un droit sur ses données ou demander une rétractation Immojudis.",
      },
    ],
  }),
  component: RightsPage,
});

const requestOptions: Array<{ value: PrivacyRequestType; label: string; detail: string }> = [
  {
    value: "access",
    label: "Accéder à mes données",
    detail: "Obtenir une copie et les informations associées.",
  },
  {
    value: "portability",
    label: "Portabilité",
    detail: "Recevoir les données fournies dans un format exploitable.",
  },
  {
    value: "rectification",
    label: "Rectification",
    detail: "Corriger une information inexacte ou incomplète.",
  },
  {
    value: "erasure",
    label: "Effacement / compte",
    detail: "Demander la suppression du compte et des données effaçables.",
  },
  {
    value: "restriction",
    label: "Limitation",
    detail: "Demander le gel temporaire d’un traitement contesté.",
  },
  {
    value: "objection",
    label: "Opposition",
    detail: "Contester un traitement fondé sur l’intérêt légitime.",
  },
  {
    value: "consent_withdrawal",
    label: "Retirer un consentement",
    detail: "Retirer un accord facultatif, notamment pour les alertes email.",
  },
  {
    value: "contract_withdrawal",
    label: "Rétractation Analyse",
    detail: "Notifier une rétractation liée à une commande Analyse.",
  },
];

export function RightsPage() {
  const queryClient = useQueryClient();
  const [requestType, setRequestType] = useState<PrivacyRequestType>("access");
  const [message, setMessage] = useState("");
  const { data, isLoading, error } = useQuery({
    queryKey: ["privacy-requests"],
    queryFn: fetchPrivacyRequests,
  });
  const mutation = useMutation({
    mutationFn: () => createPrivacyRequestClient({ requestType, message }),
    onSuccess: async () => {
      setMessage("");
      toast.success("Demande enregistrée. Son échéance est visible ci-dessous.");
      await queryClient.invalidateQueries({ queryKey: ["privacy-requests"] });
    },
    onError: (mutationError) => {
      toast.error(mutationError instanceof Error ? mutationError.message : "Demande impossible");
    },
  });

  return (
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto max-w-5xl">
        <header className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.28em] text-gold">
            <ShieldCheck className="h-4 w-4" />
            Espace authentifié
          </div>
          <h1 className="mt-4 font-display text-4xl leading-tight sm:text-5xl">Mes droits</h1>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Déposez une demande RGPD ou une notification de rétractation. L’authentification établit
            votre identité de compte ; aucune pièce d’identité n’est demandée sauf doute
            raisonnable. Une réponse ou une information sur la suite est fournie dans un délai
            maximal d’un mois.
          </p>
        </header>

        <div className="mt-6 grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
          <section className="liquid-panel rounded-lg p-5 sm:p-6">
            <h2 className="font-display text-2xl">Nouvelle demande</h2>
            <label className="mt-5 grid gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Nature de la demande
              <select
                value={requestType}
                onChange={(event) => setRequestType(event.target.value as PrivacyRequestType)}
                className="rounded-lg border border-white/10 bg-background/60 px-3 py-3 text-sm normal-case tracking-normal text-foreground"
              >
                {requestOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {requestOptions.find((option) => option.value === requestType)?.detail}
            </p>
            <label className="mt-5 grid gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Précisions utiles
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={4000}
                rows={7}
                placeholder={
                  requestType === "contract_withdrawal"
                    ? "Indiquez si possible la date de commande et toute précision utile."
                    : "Décrivez les données ou la correction concernée."
                }
                className="resize-y rounded-lg border border-white/10 bg-background/60 px-3 py-3 text-sm normal-case tracking-normal text-foreground"
              />
            </label>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              className="liquid-button mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.16em] text-background disabled:opacity-60"
            >
              <Send className="h-4 w-4" />
              {mutation.isPending ? "Enregistrement…" : "Envoyer la demande"}
            </button>
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              Consultez la{" "}
              <Link to="/privacy" className="text-gold underline">
                politique de confidentialité
              </Link>{" "}
              et les{" "}
              <Link to="/conditions-generales" className="text-gold underline">
                conditions générales
              </Link>
              .
            </p>
          </section>

          <section className="liquid-panel rounded-lg p-5 sm:p-6">
            <h2 className="font-display text-2xl">Suivi des demandes</h2>
            {isLoading ? <p className="mt-5 text-sm text-muted-foreground">Chargement…</p> : null}
            {error ? (
              <p className="mt-5 text-sm text-red-200">
                {error instanceof Error ? error.message : "Suivi indisponible"}
              </p>
            ) : null}
            {!isLoading && !data?.requests.length ? (
              <p className="mt-5 text-sm text-muted-foreground">Aucune demande enregistrée.</p>
            ) : null}
            <div className="mt-5 space-y-3">
              {data?.requests.map((request) => (
                <article key={request.id} className="liquid-panel-soft rounded-lg p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold text-foreground">
                        {requestTypeLabel(request.requestType)}
                      </h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Déposée le {formatDate(request.submittedAt)}
                      </p>
                    </div>
                    <StatusBadge status={request.status} />
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 text-gold" />
                    Échéance de réponse : {formatDate(request.dueAt)}
                  </div>
                  {request.message ? (
                    <p className="mt-3 line-clamp-3 text-xs leading-relaxed">{request.message}</p>
                  ) : null}
                  {request.resolutionCode ? (
                    <p className="mt-3 text-xs font-semibold text-foreground">
                      Résolution : {request.resolutionCode}
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const terminal = status === "completed";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${terminal ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100" : "border-gold/25 bg-gold/10 text-gold-soft"}`}
    >
      {terminal ? <CheckCircle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
      {statusLabel(status)}
    </span>
  );
}

function requestTypeLabel(value: PrivacyRequestType) {
  return requestOptions.find((option) => option.value === value)?.label ?? value;
}

function statusLabel(value: string) {
  return (
    (
      {
        received: "Reçue",
        identity_verification: "Vérification",
        in_review: "En cours",
        completed: "Traitée",
        rejected: "Clôturée",
      } as Record<string, string>
    )[value] ?? value
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}
