"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { useState } from "react";
import { toast } from "sonner";
import { fetchAdminPrivacyRequests, updateAdminPrivacyRequest } from "@/lib/client-api";
import type {
  PrivacyRequestAdminSummary,
  PrivacyRequestAdminUpdate,
  PrivacyRequestStatus,
} from "@/lib/privacy-requests";

const statusOptions: Array<{ value: PrivacyRequestStatus; label: string }> = [
  { value: "received", label: "Reçue" },
  { value: "identity_verification", label: "Vérification identité" },
  { value: "in_review", label: "En cours" },
  { value: "completed", label: "Traitée" },
  { value: "rejected", label: "Rejetée / clôturée" },
];

export function AdminPrivacyRequestsPanel() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-privacy-requests"],
    queryFn: fetchAdminPrivacyRequests,
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: (input: PrivacyRequestAdminUpdate) => updateAdminPrivacyRequest(input),
    onSuccess: async () => {
      toast.success("Demande mise à jour.");
      await queryClient.invalidateQueries({ queryKey: ["admin-privacy-requests"] });
    },
    onError: (mutationError) => {
      toast.error(
        mutationError instanceof Error ? mutationError.message : "Mise à jour impossible",
      );
    },
  });
  const requests = data?.requests ?? [];
  const openCount = requests.filter(
    (request) => !["completed", "rejected"].includes(request.status),
  ).length;
  const overdueCount = requests.filter(
    (request) =>
      !["completed", "rejected"].includes(request.status) && new Date(request.dueAt) < new Date(),
  ).length;

  return (
    <section className="liquid-panel mt-6 rounded-lg p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
            <ShieldCheck className="h-4 w-4" />
            Gouvernance des données
          </div>
          <h2 className="mt-3 font-display text-2xl">Demandes RGPD et rétractations</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {openCount} demande{openCount > 1 ? "s" : ""} ouverte{openCount > 1 ? "s" : ""}
            {overdueCount ? ` · ${overdueCount} en retard` : " · aucune échéance dépassée"}.
          </p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${overdueCount ? "border-red-300/30 bg-red-400/10 text-red-100" : "border-emerald-300/25 bg-emerald-400/10 text-emerald-100"}`}
        >
          Délai cible : 1 mois
        </span>
      </div>

      {isLoading ? <p className="mt-5 text-sm text-muted-foreground">Chargement…</p> : null}
      {error ? (
        <p className="mt-5 text-sm text-red-200">
          {error instanceof Error ? error.message : "Demandes indisponibles"}
        </p>
      ) : null}
      {!isLoading && !requests.length ? (
        <p className="mt-5 text-sm text-muted-foreground">Aucune demande enregistrée.</p>
      ) : null}

      <div className="mt-5 space-y-3">
        {requests.map((request) => (
          <PrivacyRequestEditor
            key={request.id}
            request={request}
            busy={mutation.isPending}
            onSave={(input) => mutation.mutate(input)}
          />
        ))}
      </div>
    </section>
  );
}

type IdentityStatus = "authenticated" | "additional_verification_required" | "verified";

function PrivacyRequestEditor({
  request,
  busy,
  onSave,
}: {
  request: PrivacyRequestAdminSummary;
  busy: boolean;
  onSave: (input: PrivacyRequestAdminUpdate) => void;
}) {
  const [status, setStatus] = useState<PrivacyRequestStatus>(request.status);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>(
    request.identityStatus as IdentityStatus,
  );
  const [resolutionCode, setResolutionCode] = useState(request.resolutionCode ?? "");
  const [operatorNotes, setOperatorNotes] = useState(request.operatorNotes ?? "");

  const terminal = status === "completed" || status === "rejected";

  return (
    <article className="liquid-panel-soft rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-foreground">{request.requestType}</h3>
        <span className="text-xs text-muted-foreground">{request.requesterEmail}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {request.message || "Aucune précision fournie."}
      </p>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <Clock className="h-3.5 w-3.5 text-gold" />
        Reçue le {formatDate(request.submittedAt)} · échéance {formatDate(request.dueAt)}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Statut
          <select
            value={status}
            disabled={busy}
            onChange={(event) => setStatus(event.target.value as PrivacyRequestStatus)}
            className="rounded-lg border border-white/10 bg-background/60 px-3 py-2 text-xs normal-case tracking-normal text-foreground"
          >
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Vérification d’identité
          <select
            value={identityStatus}
            disabled={busy}
            onChange={(event) => setIdentityStatus(event.target.value as IdentityStatus)}
            className="rounded-lg border border-white/10 bg-background/60 px-3 py-2 text-xs normal-case tracking-normal text-foreground"
          >
            <option value="authenticated">Compte authentifié</option>
            <option value="additional_verification_required">Complément requis</option>
            <option value="verified">Identité vérifiée</option>
          </select>
        </label>
        <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:col-span-2">
          Code de résolution {terminal ? "(obligatoire)" : ""}
          <input
            value={resolutionCode}
            maxLength={120}
            disabled={busy}
            onChange={(event) => setResolutionCode(event.target.value)}
            placeholder="Ex. access_copy_delivered"
            className="rounded-lg border border-white/10 bg-background/60 px-3 py-2 text-xs normal-case tracking-normal text-foreground"
          />
        </label>
        <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:col-span-2">
          Journal opérateur
          <textarea
            value={operatorNotes}
            maxLength={8000}
            rows={3}
            disabled={busy}
            onChange={(event) => setOperatorNotes(event.target.value)}
            placeholder="Vérifications, données remises, motif d’une limitation ou d’un refus…"
            className="resize-y rounded-lg border border-white/10 bg-background/60 px-3 py-2 text-xs normal-case tracking-normal text-foreground"
          />
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={busy || (terminal && !resolutionCode.trim())}
          onClick={() =>
            onSave({
              requestId: request.id,
              status,
              identityStatus,
              resolutionCode,
              operatorNotes,
            })
          }
          className="ij-signup-button inline-flex items-center justify-center px-4 py-2 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-50"
        >
          Enregistrer le traitement
        </button>
      </div>
    </article>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}
