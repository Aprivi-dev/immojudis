import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import Send from "lucide-react/dist/esm/icons/send.js";
import { useState } from "react";
import { toast } from "sonner";
import {
  fetchAdminLawyerReferralRequests,
  updateAdminLawyerReferralRequest,
} from "@/lib/client-api";
import type {
  AdminLawyerReferralLawyerOption,
  AdminLawyerReferralSummary,
  AdminLawyerReferralUpdateInput,
} from "@/lib/admin-lawyer-referrals";

type ReferralStatus = AdminLawyerReferralSummary["status"];

const QUERY_KEY = ["admin-lawyer-referral-requests"] as const;

const STATUS_OPTIONS: Array<[ReferralStatus, string]> = [
  ["new", "Nouvelle"],
  ["manual_review", "Revue manuelle"],
  ["sent_to_lawyer", "Envoyée avocat"],
  ["responded", "Réponse reçue"],
  ["closed", "Clôturée"],
  ["cancelled", "Annulée"],
];

export function AdminLawyerReferralRequestsPanel() {
  const queryClient = useQueryClient();
  const requestsQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchAdminLawyerReferralRequests,
    staleTime: 30_000,
  });
  const requests = requestsQuery.data?.requests ?? [];
  const lawyers = requestsQuery.data?.lawyers ?? [];
  const openCount = requests.filter((request) =>
    ["new", "manual_review", "sent_to_lawyer"].includes(request.status),
  ).length;

  const updateMutation = useMutation({
    mutationFn: (data: AdminLawyerReferralUpdateInput) =>
      updateAdminLawyerReferralRequest({ data }),
    onSuccess: async () => {
      toast.success("Demande avocat mise à jour.");
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Mise à jour impossible");
    },
  });

  return (
    <section className="liquid-panel mt-6 rounded-lg p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
            <Send className="h-4 w-4" />
            Demandes avocat
          </div>
          <h2 className="mt-3 font-display text-2xl">Suivi des mises en relation</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            File de traitement des demandes issues des annonces. Les assignations utilisent
            uniquement les avocats référencés ImmoJudis, pas les contacts source collectés.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-xs text-muted-foreground">
            {openCount} ouverte{openCount > 1 ? "s" : ""}
          </span>
          <button
            type="button"
            onClick={() => void requestsQuery.refetch()}
            className="liquid-panel-soft inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold transition hover:border-gold"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${requestsQuery.isFetching ? "animate-spin" : ""}`}
            />
            Actualiser
          </button>
        </div>
      </div>

      {requestsQuery.error ? (
        <div className="mt-4 rounded-lg border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">
          {requestsQuery.error instanceof Error
            ? requestsQuery.error.message
            : "Chargement impossible"}
        </div>
      ) : null}

      <div className="mt-5 grid gap-3">
        {requestsQuery.isLoading ? (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
            Chargement des demandes avocat
          </div>
        ) : requests.length ? (
          requests.map((request) => (
            <LawyerReferralRequestCard
              key={request.id}
              request={request}
              lawyers={lawyers}
              disabled={updateMutation.isPending}
              onSave={(input) => updateMutation.mutate(input)}
            />
          ))
        ) : (
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-muted-foreground">
            Aucune demande de mise en relation pour le moment
          </div>
        )}
      </div>
    </section>
  );
}

function LawyerReferralRequestCard({
  request,
  lawyers,
  disabled,
  onSave,
}: {
  request: AdminLawyerReferralSummary;
  lawyers: AdminLawyerReferralLawyerOption[];
  disabled: boolean;
  onSave: (input: AdminLawyerReferralUpdateInput) => void;
}) {
  const [status, setStatus] = useState<ReferralStatus>(request.status);
  const [requestedLawyerId, setRequestedLawyerId] = useState(request.requestedLawyerId ?? "");
  const [adminNotes, setAdminNotes] = useState(request.adminNotes ?? "");

  return (
    <article className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ReferralStatusPill status={request.status} />
            <span className="text-xs text-muted-foreground">
              {formatDateTime(request.createdAt)}
            </span>
            <span className="rounded-full border border-white/10 px-2.5 py-1 text-xs text-muted-foreground">
              {request.matchingStatus}
            </span>
          </div>
          <h3 className="mt-3 text-lg font-semibold text-foreground">
            {request.sale.title ?? "Vente sans titre"}
          </h3>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>
              {[request.sale.city, request.sale.department].filter(Boolean).join(" · ") ||
                "Zone à préciser"}
            </span>
            <span>
              {request.sale.tribunal ?? request.sale.tribunalCode ?? "Tribunal à préciser"}
            </span>
            <span>{formatPrice(request.sale.startingPriceEur)}</span>
            <span>
              {request.sale.saleDate ? formatDate(request.sale.saleDate) : "Audience à préciser"}
            </span>
          </div>
          <div className="mt-3 grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
            <InfoLine label="Demandeur" value={request.requesterEmail ?? request.requesterId} />
            <InfoLine
              label="Contact préféré"
              value={contactMethodLabel(request.preferredContactMethod)}
            />
            <InfoLine label="Téléphone" value={request.phone ?? "Non renseigné"} />
            <InfoLine
              label="Budget max"
              value={request.maxBidEur ? formatPrice(request.maxBidEur) : "Non renseigné"}
            />
          </div>
          {request.message ? (
            <p className="mt-3 rounded-lg border border-white/10 bg-background/25 p-3 text-sm leading-relaxed text-muted-foreground">
              {request.message}
            </p>
          ) : null}
          <div className="mt-3 text-xs text-muted-foreground">
            Assignée : {request.assignedAt ? formatDateTime(request.assignedAt) : "—"} · Envoyée :{" "}
            {request.sentAt ? formatDateTime(request.sentAt) : "—"} · Réponse :{" "}
            {request.respondedAt ? formatDateTime(request.respondedAt) : "—"}
          </div>
          {request.emailDelivery ? (
            <div className="mt-2 text-xs text-muted-foreground">
              Email avocat : {emailDeliveryLabel(request.emailDelivery.status)}
              {request.emailDelivery.recipient ? ` · ${request.emailDelivery.recipient}` : ""}
              {request.emailDelivery.detail ? ` · ${request.emailDelivery.detail}` : ""}
            </div>
          ) : null}
        </div>

        <form
          className="grid gap-3 rounded-lg border border-white/10 bg-background/20 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              id: request.id,
              status,
              requestedLawyerId: requestedLawyerId || null,
              adminNotes,
            });
          }}
        >
          <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Statut
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as ReferralStatus)}
              className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
            >
              {STATUS_OPTIONS.map(([optionValue, label]) => (
                <option key={optionValue} value={optionValue}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Avocat référencé
            <select
              value={requestedLawyerId}
              onChange={(event) => setRequestedLawyerId(event.target.value)}
              className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
            >
              <option value="">Aucun avocat assigné</option>
              {request.requestedLawyer &&
              !lawyers.some((lawyer) => lawyer.id === request.requestedLawyerId) ? (
                <option value={request.requestedLawyer.id}>
                  {lawyerOptionLabel(request.requestedLawyer)}
                </option>
              ) : null}
              {lawyers.map((lawyer) => (
                <option key={lawyer.id} value={lawyer.id}>
                  {lawyerOptionLabel(lawyer)}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Notes admin
            <textarea
              value={adminNotes}
              onChange={(event) => setAdminNotes(event.target.value)}
              rows={4}
              className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
            />
          </label>

          <button
            type="submit"
            disabled={disabled}
            className="liquid-button inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-3.5 w-3.5" />
            Sauvegarder
          </button>
        </form>
      </div>
    </article>
  );
}

function ReferralStatusPill({ status }: { status: ReferralStatus }) {
  const done = status === "responded" || status === "closed";
  const blocked = status === "cancelled";
  const tone = done
    ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
    : blocked
      ? "border-red-300/20 bg-red-500/10 text-red-100"
      : "border-amber-300/20 bg-amber-400/10 text-amber-100";

  return (
    <span className={`inline-flex w-fit rounded-full border px-2.5 py-1 text-xs ${tone}`}>
      {STATUS_OPTIONS.find(([option]) => option === status)?.[1] ?? status}
    </span>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </span>
      <span className="mt-1 block truncate text-foreground">{value}</span>
    </div>
  );
}

function lawyerOptionLabel(lawyer: AdminLawyerReferralLawyerOption): string {
  return [lawyer.displayName, lawyer.firmName, lawyer.barAssociation, lawyer.city]
    .filter(Boolean)
    .join(" · ");
}

function contactMethodLabel(value: AdminLawyerReferralSummary["preferredContactMethod"]): string {
  if (value === "phone") return "Téléphone";
  if (value === "either") return "Email ou téléphone";
  return "Email";
}

function emailDeliveryLabel(
  status: NonNullable<AdminLawyerReferralSummary["emailDelivery"]>["status"],
) {
  if (status === "sent") return "envoyé";
  if (status === "failed") return "échec";
  return "non envoyé";
}

function formatPrice(value: number | null): string {
  if (!value) return "Prix à préciser";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
