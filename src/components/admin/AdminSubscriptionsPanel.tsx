import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import CreditCard from "lucide-react/dist/esm/icons/credit-card.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Save from "lucide-react/dist/esm/icons/save.js";
import { useState } from "react";
import { toast } from "sonner";
import { fetchAdminSubscriptions, grantAdminSubscription } from "@/lib/client-api";
import type {
  AdminSubscriptionGrantInput,
  AdminSubscriptionSummary,
} from "@/lib/admin-subscriptions";
import { PLAN_LABELS, type PlanCode, type PlanStatus } from "@/lib/plans";

type SubscriptionFormState = {
  target: string;
  planCode: PlanCode;
  status: PlanStatus;
  currentPeriodEnd: string;
  note: string;
};

const SUBSCRIPTIONS_QUERY_KEY = ["admin-subscriptions"] as const;

export function AdminSubscriptionsPanel() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SubscriptionFormState>(() => emptySubscriptionForm());
  const subscriptionsQuery = useQuery({
    queryKey: SUBSCRIPTIONS_QUERY_KEY,
    queryFn: fetchAdminSubscriptions,
    staleTime: 30_000,
  });

  const subscriptions = subscriptionsQuery.data?.subscriptions ?? [];

  const grantMutation = useMutation({
    mutationFn: () => grantAdminSubscription({ data: formToInput(form) }),
    onSuccess: async (response) => {
      toast.success(
        `${PLAN_LABELS[response.subscription.planCode]} attribué à ${
          response.resolvedUser.email ?? response.resolvedUser.id
        }.`,
      );
      setForm(emptySubscriptionForm());
      await queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_QUERY_KEY });
      await queryClient.invalidateQueries({ queryKey: ["admin-dashboard"] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Attribution impossible");
    },
  });

  return (
    <section className="liquid-panel mt-6 rounded-lg p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold">
            <CreditCard className="h-4 w-4" />
            Accès payants
          </div>
          <h2 className="mt-3 font-display text-2xl">Attribution manuelle des plans</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Active un accès Analyse pour 30 jours ou replace un compte en Découverte, utile pour les
            ventes assistées et les essais commerciaux.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void subscriptionsQuery.refetch()}
          className="liquid-panel-soft inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-gold transition hover:border-gold"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${subscriptionsQuery.isFetching ? "animate-spin" : ""}`}
          />
          Actualiser
        </button>
      </div>

      {subscriptionsQuery.error ? (
        <div className="mt-4 rounded-lg border border-red-300/20 bg-red-500/10 p-3 text-sm text-red-100">
          {subscriptionsQuery.error instanceof Error
            ? subscriptionsQuery.error.message
            : "Chargement impossible"}
        </div>
      ) : null}

      <div className="mt-5 grid gap-4 xl:grid-cols-[0.82fr_1.18fr]">
        <form
          className="rounded-lg border border-white/10 bg-white/[0.03] p-4"
          onSubmit={(event) => {
            event.preventDefault();
            grantMutation.mutate();
          }}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label="Email ou UUID utilisateur"
              value={form.target}
              required
              onChange={(target) => setForm((current) => ({ ...current, target }))}
            />
            <SelectField
              label="Plan"
              value={form.planCode}
              options={[
                ["analyse", PLAN_LABELS.analyse],
                ["decouverte", PLAN_LABELS.decouverte],
              ]}
              onChange={(planCode) =>
                setForm((current) => ({ ...current, planCode: planCode as PlanCode }))
              }
            />
            <SelectField
              label="Statut"
              value={form.status}
              options={[
                ["active", "Actif"],
                ["trialing", "Essai"],
                ["past_due", "Paiement en retard"],
                ["paused", "Pause"],
                ["cancelled", "Résilié"],
                ["expired", "Expiré"],
              ]}
              onChange={(status) =>
                setForm((current) => ({ ...current, status: status as PlanStatus }))
              }
            />
            <TextField
              label="Fin de période"
              type="datetime-local"
              value={form.currentPeriodEnd}
              onChange={(currentPeriodEnd) =>
                setForm((current) => ({ ...current, currentPeriodEnd }))
              }
            />
          </div>

          <label className="mt-3 grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Note interne
            <textarea
              value={form.note}
              onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
              rows={3}
              className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
            />
          </label>

          <button
            type="submit"
            disabled={grantMutation.isPending}
            className="liquid-button mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.16em] text-background disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Save className="h-3.5 w-3.5" />
            {grantMutation.isPending ? "Attribution" : "Attribuer le plan"}
          </button>
        </form>

        <div className="overflow-hidden rounded-lg border border-white/10">
          <div className="grid grid-cols-[1.1fr_0.75fr_0.7fr_0.8fr] gap-3 bg-white/[0.04] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            <span>Compte</span>
            <span>Plan</span>
            <span>Statut</span>
            <span>Maj</span>
          </div>
          <div className="divide-y divide-white/10">
            {subscriptionsQuery.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Chargement</div>
            ) : subscriptions.length ? (
              subscriptions.map((subscription) => (
                <SubscriptionLine key={subscription.userId} subscription={subscription} />
              ))
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                Aucun accès payant attribué pour le moment
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function SubscriptionLine({ subscription }: { subscription: AdminSubscriptionSummary }) {
  return (
    <div className="grid grid-cols-[1.1fr_0.75fr_0.7fr_0.8fr] items-center gap-3 px-3 py-3 text-sm">
      <div className="min-w-0">
        <div className="truncate font-semibold text-foreground">
          {subscription.email ?? "Email inconnu"}
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {subscription.userId}
        </div>
      </div>
      <span className="truncate text-xs text-muted-foreground">
        {PLAN_LABELS[subscription.planCode]}
      </span>
      <StatusPill status={subscription.status} />
      <span className="text-xs text-muted-foreground">{formatDate(subscription.updatedAt)}</span>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
}) {
  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={type}
        required={required}
        className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-white/10 bg-background/45 px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
      >
        {options.map(([optionValue, label]) => (
          <option key={optionValue} value={optionValue}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StatusPill({ status }: { status: PlanStatus }) {
  const active = status === "active" || status === "trialing";
  return (
    <span
      className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-[11px] ${
        active
          ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
          : "border-amber-300/20 bg-amber-400/10 text-amber-100"
      }`}
    >
      {status}
    </span>
  );
}

function emptySubscriptionForm(): SubscriptionFormState {
  return {
    target: "",
    planCode: "analyse",
    status: "active",
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16),
    note: "",
  };
}

function formToInput(form: SubscriptionFormState): AdminSubscriptionGrantInput {
  return {
    target: form.target,
    planCode: form.planCode,
    status: form.status,
    currentPeriodEnd: form.currentPeriodEnd,
    note: form.note,
  };
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
