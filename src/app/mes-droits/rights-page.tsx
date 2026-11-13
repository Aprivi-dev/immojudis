"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CheckCircle from "lucide-react/dist/esm/icons/check-circle.js";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import { useState } from "react";
import { formatDate } from "@/lib/format/dates";
import { toast } from "@/lib/toast";
import Link from "next/link";
import { Badge, buttonClasses, Card, Notice, PageShell } from "@/components/ui/primitives";
import { createPrivacyRequestClient, fetchPrivacyRequests } from "@/lib/client-api";
import type { PrivacyRequestType } from "@/lib/privacy-requests";
import { userMessage } from "@/lib/user-messages";
import * as queryKeys from "@/lib/query-keys";

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
    queryKey: queryKeys.privacyRequests(),
    queryFn: fetchPrivacyRequests,
  });
  const mutation = useMutation({
    mutationFn: () => createPrivacyRequestClient({ requestType, message }),
    onSuccess: async () => {
      setMessage("");
      toast.success("Demande enregistrée. Son échéance est visible ci-dessous.");
      await queryClient.invalidateQueries({ queryKey: queryKeys.privacyRequests() });
    },
    onError: (mutationError) => {
      toast.error(userMessage(mutationError, "Demande impossible"));
    },
  });

  return (
    <PageShell
      eyebrow="Espace authentifié"
      title="Mes droits"
      description={
        <p>
          Déposez une demande RGPD ou une notification de rétractation. L’authentification établit
          votre identité de compte ; aucune pièce d’identité n’est demandée sauf doute raisonnable.
          Une réponse ou une information sur la suite est fournie dans un délai maximal d’un mois.
        </p>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
        <Card as="section" aria-labelledby="rights-new-title" className="sm:p-6">
          <h2 id="rights-new-title" className="font-display text-2xl font-semibold text-brand-navy">
            Nouvelle demande
          </h2>
          <label className="mt-5 grid gap-2 text-sm font-semibold text-brand-navy">
            Nature de la demande
            <select
              value={requestType}
              onChange={(event) => setRequestType(event.target.value as PrivacyRequestType)}
              aria-describedby="rights-request-detail"
              className="form-input font-normal"
            >
              {requestOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <p id="rights-request-detail" className="mt-2 text-sm leading-relaxed text-ink-soft">
            {requestOptions.find((option) => option.value === requestType)?.detail}
          </p>
          <label className="mt-5 grid gap-2 text-sm font-semibold text-brand-navy">
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
              className="form-textarea font-normal"
            />
          </label>
          <button
            type="button"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
            className={buttonClasses({ variant: "primary", className: "mt-5 w-full" })}
          >
            <Send className="h-4 w-4" aria-hidden />
            {mutation.isPending ? "Enregistrement…" : "Envoyer la demande"}
          </button>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            Consultez la{" "}
            <Link href="/privacy" className="text-gold-text underline">
              politique de confidentialité
            </Link>{" "}
            et les{" "}
            <Link href="/conditions-generales" className="text-gold-text underline">
              conditions générales
            </Link>
            .
          </p>
        </Card>

        <Card as="section" aria-labelledby="rights-follow-title" className="sm:p-6">
          <h2
            id="rights-follow-title"
            className="font-display text-2xl font-semibold text-brand-navy"
          >
            Suivi des demandes
          </h2>
          {isLoading ? (
            <p role="status" className="mt-5 text-sm text-ink-soft">
              Chargement…
            </p>
          ) : null}
          {error ? (
            <Notice tone="danger" role="alert" className="mt-5">
              {userMessage(error, "Suivi indisponible")}
            </Notice>
          ) : null}
          {!isLoading && !data?.requests.length ? (
            <p className="mt-5 text-sm text-ink-soft">Aucune demande enregistrée.</p>
          ) : null}
          <div className="mt-5 space-y-3">
            {data?.requests.map((request) => (
              <article key={request.id} className="rounded-lg border border-line bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-foreground">
                      {requestTypeLabel(request.requestType)}
                    </h3>
                    <p className="mt-1 text-sm text-ink-soft">
                      Déposée le {formatDate(request.submittedAt)}
                    </p>
                  </div>
                  <StatusBadge status={request.status} />
                </div>
                <div className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
                  <Clock className="h-3.5 w-3.5 text-gold-text" aria-hidden />
                  Échéance de réponse : {formatDate(request.dueAt)}
                </div>
                {request.message ? (
                  <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-foreground">
                    {request.message}
                  </p>
                ) : null}
                {request.resolutionCode ? (
                  <p className="mt-3 text-sm font-semibold text-foreground">
                    Résolution : {request.resolutionCode}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </Card>
      </div>
    </PageShell>
  );
}

function StatusBadge({ status }: { status: string }) {
  const terminal = status === "completed";
  return (
    <Badge tone={terminal ? "success" : "gold"} className="shrink-0">
      {terminal ? (
        <CheckCircle className="h-3 w-3" aria-hidden />
      ) : (
        <Clock className="h-3 w-3" aria-hidden />
      )}
      {statusLabel(status)}
    </Badge>
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
