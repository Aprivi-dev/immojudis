"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Clock from "lucide-react/dist/esm/icons/clock.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { useState } from "react";
import { queryErrorMessage } from "@/components/admin/admin-format";
import { AdminPill } from "@/components/admin/admin-pill";
import { formatShortDate } from "@/lib/format/dates";
import { formatPriceWithCents } from "@/lib/format/numbers";
import { toast } from "@/lib/toast";
import {
  executeAdminContractWithdrawal,
  executeAdminPrivacyErasure,
  fetchAdminAccountPrivacyExport,
  fetchAdminContractWithdrawalContext,
  fetchAdminErasureGuard,
  fetchAdminPrivacyRequests,
  fetchAdminProfessionalPrivacyExport,
  updateAdminPrivacyRequest,
} from "@/lib/client-api";
import { downloadBlob } from "@/lib/download-blob";
import {
  CONTRACT_WITHDRAWAL_RESPONSE_DAYS,
  privacyDeadlineLabel,
  privacyResponseDelayLabel,
  WITHDRAWAL_PERIOD_DAYS,
} from "@/lib/privacy-deadline";
import {
  ERASURE_CLOSED_WITHOUT_EXECUTION_CODES,
  privacyRequestTypeLabel,
} from "@/lib/privacy-request-types";
import type {
  PrivacyErasureExecuteInput,
  PrivacyRequestAdminSummary,
  PrivacyRequestAdminUpdate,
  PrivacyRequestStatus,
} from "@/lib/privacy-requests";
import { AdminPagination } from "@/components/admin/AdminPagination";
import { adminOfTotal } from "@/lib/admin-pagination";
import { PRIVACY_REQUESTS_QUERY_KEY } from "@/lib/admin-query-keys";

const statusOptions: Array<{ value: PrivacyRequestStatus; label: string }> = [
  { value: "received", label: "Reçue" },
  { value: "identity_verification", label: "Vérification identité" },
  { value: "in_review", label: "En cours" },
  { value: "completed", label: "Traitée" },
  { value: "rejected", label: "Rejetée / clôturée" },
];

export function AdminPrivacyRequestsPanel() {
  const queryClient = useQueryClient();
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: [...PRIVACY_REQUESTS_QUERY_KEY, offset],
    queryFn: () => fetchAdminPrivacyRequests({ offset }),
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: (input: PrivacyRequestAdminUpdate) => updateAdminPrivacyRequest(input),
    onSuccess: async () => {
      toast.success("Demande mise à jour.");
      await queryClient.invalidateQueries({ queryKey: PRIVACY_REQUESTS_QUERY_KEY });
    },
    onError: (mutationError) => {
      toast.error(queryErrorMessage(mutationError, "Mise à jour impossible"));
    },
  });
  const withdrawal = useMutation({
    mutationFn: executeAdminContractWithdrawal,
    onSuccess: async (result) => {
      toast.success(
        `Rétractation exécutée : ${formatPriceWithCents(result.refundedCents / 100)} remboursés.`,
      );
      await queryClient.invalidateQueries({ queryKey: PRIVACY_REQUESTS_QUERY_KEY });
    },
    onError: (mutationError) => {
      toast.error(queryErrorMessage(mutationError, "Rétractation impossible"));
    },
  });
  const erasure = useMutation({
    mutationFn: (input: PrivacyErasureExecuteInput) => executeAdminPrivacyErasure(input),
    onSuccess: async () => {
      toast.success(
        "Effacement exécuté : données du demandeur supprimées (compte et client Stripe, s'il en avait).",
      );
      await queryClient.invalidateQueries({ queryKey: PRIVACY_REQUESTS_QUERY_KEY });
    },
    onError: (mutationError) => {
      toast.error(queryErrorMessage(mutationError, "Effacement impossible"));
    },
  });
  const professionalExport = useMutation({
    mutationFn: fetchAdminProfessionalPrivacyExport,
    onSuccess: (result) => {
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      downloadBlob(blob, `donnees-professionnel-${result.generatedAt.slice(0, 10)}.json`);
      toast.success("Export des données du professionnel téléchargé.");
    },
    onError: (mutationError) => {
      toast.error(queryErrorMessage(mutationError, "Export impossible"));
    },
  });
  const accountExport = useMutation({
    mutationFn: fetchAdminAccountPrivacyExport,
    onSuccess: (result) => {
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
      downloadBlob(blob, `donnees-compte-${result.generatedAt.slice(0, 10)}.json`);
      toast.success("Export des données du compte téléchargé.");
    },
    onError: (mutationError) => {
      toast.error(queryErrorMessage(mutationError, "Export impossible"));
    },
  });
  const requests = data?.requests ?? [];
  const dueSoonCount = requests.filter((request) => request.deadline?.dueSoon).length;
  const openCount =
    data?.openCount ??
    requests.filter((request) => !["completed", "rejected"].includes(request.status)).length;
  const overdueCount =
    data?.overdueCount ??
    requests.filter(
      (request) =>
        !["completed", "rejected"].includes(request.status) && new Date(request.dueAt) < new Date(),
    ).length;

  return (
    <section className="admin-panel mt-6 rounded-lg p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold-text">
            <ShieldCheck className="h-4 w-4" />
            Gouvernance des données
          </div>
          <h2 className="mt-3 font-display text-2xl">Demandes RGPD et rétractations</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {openCount} demande{openCount > 1 ? "s" : ""} ouverte{openCount > 1 ? "s" : ""}
            {overdueCount ? ` · ${overdueCount} en retard` : " · aucune échéance dépassée"}.
          </p>
          {dueSoonCount ? (
            <p role="alert" className="mt-2 text-sm font-semibold text-amber-200">
              {dueSoonCount} demande{dueSoonCount > 1 ? "s" : ""} à traiter avant J-7 : l'échéance
              d'un mois approche.
            </p>
          ) : null}
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${overdueCount ? "border-red-300/30 bg-red-400/10 text-danger" : "border-emerald-300/25 bg-success-tint text-success"}`}
        >
          Délai cible : 1 mois ({CONTRACT_WITHDRAWAL_RESPONSE_DAYS} jours pour une rétractation)
        </span>
      </div>

      {isLoading ? <p className="mt-5 text-sm text-muted-foreground">Chargement…</p> : null}
      {error ? (
        <p className="mt-5 text-sm text-danger">
          {queryErrorMessage(error, "Demandes indisponibles")}
        </p>
      ) : null}
      {data ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {requests.length} demande{requests.length > 1 ? "s" : ""} récente
          {requests.length > 1 ? "s" : ""} affichée{requests.length > 1 ? "s" : ""}
          {adminOfTotal(data.total)}. Les compteurs ouverts et en retard couvrent toute la file.
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
            busy={
              mutation.isPending ||
              withdrawal.isPending ||
              erasure.isPending ||
              professionalExport.isPending ||
              accountExport.isPending
            }
            onSave={(input) => mutation.mutate(input)}
            onWithdraw={(refundMode) =>
              // Appelé par le bouton de confirmation seulement.
              withdrawal.mutate({ requestId: request.id, refundMode, confirm: true })
            }
            onErase={(input) => erasure.mutate(input)}
            onExportProfessional={(requestId) => professionalExport.mutate(requestId)}
            onExportAccount={(requestId) => accountExport.mutate(requestId)}
          />
        ))}
      </div>
      {data ? (
        <AdminPagination
          label="demandes RGPD et rétractations"
          offset={data.offset}
          limit={data.limit}
          total={data.total}
          shown={requests.length}
          busy={isFetching}
          onOffsetChange={setOffset}
        />
      ) : null}
    </section>
  );
}

type IdentityStatus = "authenticated" | "additional_verification_required" | "verified";

const NOTIFICATION_LABELS: Record<string, string> = {
  sent: "envoyé",
  pending: "en attente",
  failed: "en échec",
};

function notificationLabel(status: string | null | undefined): string {
  return status ? (NOTIFICATION_LABELS[status] ?? status) : "non suivi";
}

function PrivacyRequestEditor({
  request,
  busy,
  onSave,
  onWithdraw,
  onErase,
  onExportProfessional,
  onExportAccount,
}: {
  request: PrivacyRequestAdminSummary;
  busy: boolean;
  onSave: (input: PrivacyRequestAdminUpdate) => void;
  onWithdraw: (refundMode: "prorata" | "full") => void;
  onErase: (input: PrivacyErasureExecuteInput) => void;
  onExportProfessional: (requestId: string) => void;
  onExportAccount: (requestId: string) => void;
}) {
  const [status, setStatus] = useState<PrivacyRequestStatus>(request.status);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>(
    request.identityStatus as IdentityStatus,
  );
  const [resolutionCode, setResolutionCode] = useState(request.resolutionCode ?? "");
  const [operatorNotes, setOperatorNotes] = useState(request.operatorNotes ?? "");
  const [response, setResponse] = useState(request.closureResponse ?? "");

  const terminal = status === "completed" || status === "rejected";
  const closed = request.status === "completed" || request.status === "rejected";
  const missingResponse = status === "rejected" && !response.trim();

  return (
    <article className="admin-panel rounded-lg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold text-foreground">
          {privacyRequestTypeLabel(request.requestType)}
        </h3>
        <span className="text-xs text-muted-foreground">{request.requesterEmail}</span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {request.message || "Aucune précision fournie."}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Clock className="h-3.5 w-3.5 text-gold-text" />
        Reçue le {formatShortDate(request.submittedAt)} · échéance {formatShortDate(request.dueAt)}{" "}
        ({privacyResponseDelayLabel(request.requestType)})
        {request.deadline ? (
          <AdminPill
            tone={
              request.deadline.overdue ? "danger" : request.deadline.dueSoon ? "warning" : "neutral"
            }
          >
            {privacyDeadlineLabel(request.deadline)}
          </AdminPill>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Exploitation prévenue : {notificationLabel(request.notifications?.operator)} · accusé de
        réception : {notificationLabel(request.notifications?.acknowledgement)}
        {request.notifications?.closure
          ? ` · email de clôture : ${notificationLabel(request.notifications.closure)}`
          : ""}
        .
      </p>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Statut
          <select
            value={status}
            disabled={busy}
            onChange={(event) => setStatus(event.target.value as PrivacyRequestStatus)}
            className="rounded-lg border border-brand-navy/10 bg-background/60 px-3 py-2 text-xs normal-case tracking-normal text-foreground"
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
            className="rounded-lg border border-brand-navy/10 bg-background/60 px-3 py-2 text-xs normal-case tracking-normal text-foreground"
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
            placeholder={
              request.requestType === "erasure"
                ? `Traitée sans exécution : ${ERASURE_CLOSED_WITHOUT_EXECUTION_CODES.join(" ou ")}`
                : "Ex. access_copy_delivered"
            }
            className="rounded-lg border border-brand-navy/10 bg-background/60 px-3 py-2 text-xs normal-case tracking-normal text-foreground"
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
            className="resize-y rounded-lg border border-brand-navy/10 bg-background/60 px-3 py-2 text-xs normal-case tracking-normal text-foreground"
          />
        </label>
        <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground md:col-span-2">
          Réponse au demandeur {status === "rejected" ? "(obligatoire : motifs du refus)" : ""}
          <textarea
            value={response}
            maxLength={2000}
            rows={2}
            disabled={busy || closed}
            onChange={(event) => setResponse(event.target.value)}
            placeholder="Reprise dans l’email de clôture envoyé au demandeur : suites données, motifs d’un refus."
            className="resize-y rounded-lg border border-brand-navy/10 bg-background/60 px-3 py-2 text-xs normal-case tracking-normal text-foreground"
          />
        </label>
      </div>
      {request.requestType === "contract_withdrawal" && !closed ? (
        <WithdrawalSection request={request} busy={busy} onWithdraw={onWithdraw} />
      ) : null}
      {(request.requestType === "access" || request.requestType === "portability") &&
      request.subjectKind === "information_agent_professional" &&
      !terminal ? (
        <div className="mt-4 rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">
            Professionnel contacté par l'agent d'information (sans compte, adresse vérifiée par le
            lien signé de l'email). Le fichier est à envoyer à l'adresse du demandeur, pas ailleurs.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => onExportProfessional(request.id)}
            className="mt-3 rounded-lg border border-brand-navy/30 px-4 py-2 text-xs font-bold disabled:opacity-50"
          >
            Télécharger les données du professionnel (JSON)
          </button>
        </div>
      ) : null}
      {(request.requestType === "access" || request.requestType === "portability") &&
      request.subjectKind === "account" &&
      request.userId &&
      !terminal ? (
        <div className="mt-4 rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">
            Titulaire d'un compte : l'export reprend les données effacées avec le compte (même
            liste), le compte et ses demandes, sans secret ni identifiant technique. Le fichier est
            à envoyer à l'adresse du demandeur, pas ailleurs.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => onExportAccount(request.id)}
            className="mt-3 rounded-lg border border-brand-navy/30 px-4 py-2 text-xs font-bold disabled:opacity-50"
          >
            Télécharger les données du compte (JSON)
          </button>
        </div>
      ) : null}
      {request.requestType === "erasure" && !terminal ? (
        <ErasureSection request={request} busy={busy} onErase={onErase} />
      ) : null}
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={busy || (terminal && !resolutionCode.trim()) || missingResponse}
          onClick={() =>
            onSave({
              requestId: request.id,
              status,
              identityStatus,
              resolutionCode,
              operatorNotes,
              ...(response.trim() ? { response } : {}),
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

/**
 * Rétractation : l'abonnement (résiliation et remboursement au prorata ou intégral) ou un achat à
 * l'unité (remboursement intégral). Pour un achat, les CGU (art. 2 bis et 6) prévoient la perte du
 * droit une fois l'accès fourni : le panneau montre les faits, l'opérateur décide (exécuter, ou
 * clôturer la demande avec ses motifs). Aucun refus automatique.
 */
function WithdrawalSection({
  request,
  busy,
  onWithdraw,
}: {
  request: PrivacyRequestAdminSummary;
  busy: boolean;
  onWithdraw: (refundMode: "prorata" | "full") => void;
}) {
  const [withdrawalMode, setWithdrawalMode] = useState<"prorata" | "full">("prorata");
  const [armed, setArmed] = useState(false);
  const purchase = Boolean(request.withdrawalPurchaseId);
  const context = useQuery({
    queryKey: [...PRIVACY_REQUESTS_QUERY_KEY, "withdrawal", request.id],
    queryFn: () => fetchAdminContractWithdrawalContext(request.id),
    staleTime: 30_000,
  });
  const facts = context.data?.target === "sale_unlock_purchase" ? context.data.purchase : null;
  const yesNo = (value: boolean | null | undefined) =>
    value == null ? "inconnu" : value ? "oui" : "non";
  return (
    <div className="mt-4 rounded-lg border border-gold/25 bg-gold/5 p-3 text-xs">
      <p className="font-semibold text-foreground">Exécuter la rétractation</p>
      {purchase ? (
        <>
          <p className="mt-1 text-muted-foreground">
            Achat d’une vente à l’unité : rembourse intégralement son paiement, puis Stripe prévient
            le site, qui retire le déblocage. L’abonnement n’est pas touché. Clôt la demande.
          </p>
          {facts ? (
            <ul className="mt-2 space-y-1 text-muted-foreground">
              <li>
                Payé le {formatShortDate(facts.paidAt)} :{" "}
                {formatPriceWithCents(facts.amountCents / 100)} ({facts.state}) ; délai de{" "}
                {WITHDRAWAL_PERIOD_DAYS} jours à compter du paiement :{" "}
                {facts.withinWithdrawalPeriod ? "en cours" : "dépassé"}.
              </li>
              <li>Accès fourni (vente ouverte avec cet achat) : {yesNo(facts.accessProvided)}.</li>
              <li>
                Renonciation expresse cochée avant le paiement : {yesNo(facts.waiverAcknowledged)} ;
                confirmation de commande envoyée : {yesNo(facts.confirmationSent)}.
              </li>
            </ul>
          ) : context.data?.target === "sale_unlock_purchase" ? (
            <p className="mt-2 text-danger">Achat introuvable pour ce compte.</p>
          ) : null}
          <p className="mt-2 text-muted-foreground">
            CGU, art. 6 : pour l’achat d’une vente à l’unité, le client « reconnaît avant le
            paiement perdre son droit de rétractation une fois l’accès fourni ». À vous de décider :
            exécuter, ou passer la demande en « Rejetée » avec vos motifs.
          </p>
        </>
      ) : (
        <p className="mt-1 text-muted-foreground">
          Résilie l’abonnement Stripe immédiatement, rembourse selon le mode choisi, coupe l’accès
          et clôt la demande.
          {context.data?.target === "subscription" && !context.data.hasStripeSubscription
            ? " Aucun abonnement Stripe sur ce compte : l’exécution sera refusée, clôturez la demande avec vos motifs."
            : ""}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {purchase ? null : (
          <select
            aria-label="Mode de remboursement"
            value={withdrawalMode}
            disabled={busy}
            onChange={(event) => {
              setWithdrawalMode(event.target.value as "prorata" | "full");
              setArmed(false);
            }}
            className="rounded-lg border border-brand-navy/10 bg-background/60 px-3 py-2 text-xs text-foreground"
          >
            <option value="prorata">Remboursement au prorata du service fourni</option>
            <option value="full">Remboursement intégral</option>
          </select>
        )}
        {armed ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setArmed(false);
                onWithdraw(purchase ? "full" : withdrawalMode);
              }}
              className="rounded-lg bg-red-700 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
            >
              {purchase ? "Confirmer : rembourser l’achat" : "Confirmer : résilier et rembourser"}
            </button>
            <button
              type="button"
              onClick={() => setArmed(false)}
              className="rounded-lg border border-brand-navy/10 px-3 py-2 text-xs"
            >
              Annuler
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setArmed(true)}
            className="rounded-lg border border-red-400/40 px-4 py-2 text-xs font-bold text-red-700 disabled:opacity-50"
          >
            {purchase ? "Rembourser l’achat" : "Résilier et rembourser"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Effacement : l'adresse retapée, et, quand le compte a un abonnement actif, un achat encore
 * rétractable ou un crédit non utilisé (garde calculée par le serveur), une confirmation de plus.
 */
function ErasureSection({
  request,
  busy,
  onErase,
}: {
  request: PrivacyRequestAdminSummary;
  busy: boolean;
  onErase: (input: PrivacyErasureExecuteInput) => void;
}) {
  const [confirmEmail, setConfirmEmail] = useState("");
  const [confirmLoss, setConfirmLoss] = useState(false);
  const professional = request.subjectKind === "information_agent_professional";
  const guard = useQuery({
    queryKey: [...PRIVACY_REQUESTS_QUERY_KEY, "erasure-guard", request.id],
    queryFn: () => fetchAdminErasureGuard(request.id),
    enabled: Boolean(request.userId),
    staleTime: 30_000,
  });
  const requiresConfirmation = guard.data?.requiresConfirmation ?? false;
  return (
    <div className="mt-4 rounded-lg border border-red-300/25 bg-red-400/5 p-3">
      <p className="text-xs text-red-100">
        {professional
          ? "Exécuter l'effacement supprime définitivement les messages, dossiers et pièces de l'agent d'information liés à cette adresse, qui reste sur la liste des contacts à ne plus solliciter. Traitez d'abord les « Retraits à faire » de cette adresse : après l'effacement, les valeurs affichées ne peuvent plus être listées."
          : request.userId
            ? "Exécuter l'effacement supprime définitivement les clients Stripe, les données applicatives et le compte."
            : "Le compte n'existe plus : l'exécution termine ce qui ne dépend pas de lui (clients Stripe, journal des emails et invitations à cette adresse) et clôt la demande."}{" "}
        Identité vérifiée requise ; action irréversible. Le demandeur reçoit un email de clôture.
      </p>
      {guard.data?.reasons.length ? (
        <div role="alert" className="mt-3 rounded-lg border border-amber-300/30 p-2 text-xs">
          <p className="font-semibold text-amber-200">Avant d'effacer :</p>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-amber-100">
            {guard.data.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <label className="mt-2 flex items-center gap-2 text-amber-100">
            <input
              type="checkbox"
              checked={confirmLoss}
              disabled={busy}
              onChange={(event) => setConfirmLoss(event.target.checked)}
            />
            Je confirme l'effacement malgré ces éléments.
          </label>
        </div>
      ) : null}
      {guard.error ? (
        <p className="mt-2 text-xs text-danger">
          {queryErrorMessage(guard.error, "Vérification avant effacement impossible")}
        </p>
      ) : null}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={confirmEmail}
          disabled={busy}
          onChange={(event) => setConfirmEmail(event.target.value)}
          placeholder="Retapez l'email du demandeur pour confirmer"
          aria-label="Email du demandeur pour confirmer l'effacement"
          className="flex-1 rounded-lg border border-white/10 bg-background/60 px-3 py-2 text-xs text-foreground"
        />
        <button
          type="button"
          disabled={
            busy ||
            request.identityStatus !== "verified" ||
            confirmEmail.trim().toLowerCase() !== request.requesterEmail.toLowerCase() ||
            (requiresConfirmation && !confirmLoss)
          }
          onClick={() =>
            onErase({
              requestId: request.id,
              confirmEmail,
              ...(requiresConfirmation && confirmLoss ? { confirmFinancialImpact: true } : {}),
            })
          }
          className="rounded-lg border border-red-300/40 bg-red-500/20 px-4 py-2 text-xs font-bold text-red-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Exécuter l'effacement
        </button>
      </div>
    </div>
  );
}
