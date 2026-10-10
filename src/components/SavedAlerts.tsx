"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import { useAuth } from "@/hooks/use-auth";
import { createAlert, getAlerts, updateAlert, deleteAlert } from "@/lib/queries";
import {
  createWatchedZone,
  deleteWatchedZone,
  evaluateAlertMatches,
  fetchAccessPlan,
  fetchWatchedZones,
} from "@/lib/client-api";
import {
  ALERT_FREQUENCY_LABELS,
  alertCriteriaSummary,
  normalizeAlertFrequency,
  type AlertFrequency,
} from "@/lib/alert-criteria-labels";
import { formatDate } from "@/lib/format";
import type { UserAlert, UserWatchedZone } from "@/lib/types";
import { toast } from "sonner";
import { userMessage } from "@/lib/user-messages";
import { Badge, Button, Card, PageShell, buttonClasses } from "@/components/ui/primitives";
import { queryKeys } from "@/lib/query-keys";

export function SavedAlerts() {
  const { user, loading } = useAuth();
  if (loading || !user) return null;
  return <AccountAlerts key={user.id} userId={user.id} />;
}

type AlertAction =
  | { kind: "pause" | "resume"; id: string }
  | { kind: "delete"; alert: UserAlert }
  | { kind: "zone"; zone: UserWatchedZone; linkedAlerts: UserAlert[] }
  | { kind: "frequency"; id: string; frequency: AlertFrequency }
  | {
      kind: "edit";
      id: string;
      patch: Pick<UserAlert, "name" | "alert_frequency" | "max_price_eur" | "min_surface_m2">;
    };

function alertPayload(alert: UserAlert) {
  return {
    name: alert.name,
    department: alert.department,
    city: alert.city,
    property_type: alert.property_type,
    max_price_eur: alert.max_price_eur,
    min_surface_m2: alert.min_surface_m2,
    occupancy_status: alert.occupancy_status,
    min_investment_score: alert.min_investment_score,
    max_price_per_m2: alert.max_price_per_m2,
    min_yield_pct: alert.min_yield_pct,
    min_market_discount_pct: alert.min_market_discount_pct,
    dpe_classes: alert.dpe_classes,
    require_house_with_land: alert.require_house_with_land,
    alert_frequency: alert.alert_frequency,
    watched_zone_id: alert.watched_zone_id,
    advanced_criteria: alert.advanced_criteria as never,
    is_active: alert.is_active,
  };
}

function AccountAlerts({ userId }: { userId: string }) {
  const client = useQueryClient();
  const alertsKey = queryKeys.savedAlerts(userId);
  const zonesKey = queryKeys.watchedZones(userId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const alerts = useQuery({ queryKey: alertsKey, queryFn: () => getAlerts(userId) });
  const zones = useQuery({
    queryKey: zonesKey,
    queryFn: () => fetchWatchedZones({ includeInactive: true }),
  });
  const plan = useQuery({
    queryKey: ["feature-entitlements", userId, "plan"],
    queryFn: fetchAccessPlan,
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Les alertes hebdomadaires demandent l'offre Analyse (règle appliquée par la base).
  const weeklyAllowed = plan.data?.plan.hasAnalysisAccess === true;

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: alertsKey }),
      client.invalidateQueries({ queryKey: zonesKey }),
    ]);

  async function undoAlertDelete(alert: UserAlert) {
    try {
      await createAlert(userId, alertPayload(alert));
      await refresh();
      toast.success("Alerte rétablie.");
    } catch (error) {
      toast.error(userMessage(error, "Impossible de rétablir cette alerte."));
    }
  }

  async function undoZoneDelete(zone: UserWatchedZone, linkedAlerts: UserAlert[]) {
    try {
      const restored = await createWatchedZone({
        data: {
          name: zone.name,
          zoneKind: zone.zone_kind,
          department: zone.department,
          city: zone.city,
          postalCodePrefix: zone.postal_code_prefix,
          centerLat: zone.center_lat,
          centerLng: zone.center_lng,
          radiusKm: zone.radius_km,
          alertDefaults: zone.alert_defaults as never,
          isActive: zone.is_active,
        },
      });
      await Promise.all(
        linkedAlerts.map((alert) =>
          updateAlert(userId, alert.id, {
            watched_zone_id: restored.zone.id,
            is_active: alert.is_active,
          }),
        ),
      );
      await refresh();
      toast.success("Zone rétablie.");
    } catch (error) {
      toast.error(userMessage(error, "Impossible de rétablir cette zone."));
    }
  }

  const mutation = useMutation({
    mutationFn: async (action: AlertAction) => {
      switch (action.kind) {
        case "zone":
          return deleteWatchedZone({ zoneId: action.zone.id });
        case "delete":
          return deleteAlert(userId, action.alert.id);
        case "frequency":
          return updateAlert(userId, action.id, { alert_frequency: action.frequency });
        case "edit":
          return updateAlert(userId, action.id, action.patch);
        default:
          return updateAlert(userId, action.id, { is_active: action.kind === "resume" });
      }
    },
    onSuccess: async (_result, action) => {
      await refresh();
      if (action.kind === "delete") {
        toast("Alerte supprimée", {
          duration: 5000,
          action: { label: "Annuler", onClick: () => void undoAlertDelete(action.alert) },
        });
      } else if (action.kind === "zone") {
        toast("Zone supprimée", {
          duration: 5000,
          action: {
            label: "Annuler",
            onClick: () => void undoZoneDelete(action.zone, action.linkedAlerts),
          },
        });
      } else if (action.kind === "edit") {
        setEditingId(null);
        toast.success("Alerte modifiée.");
      }
    },
    onError: (error, action) =>
      toast.error(
        userMessage(
          error,
          action.kind === "frequency" && action.frequency === "weekly"
            ? "Cette fréquence n’est pas disponible avec votre offre."
            : "Modification impossible. Réessayez dans un instant.",
        ),
      ),
  });
  const evaluation = useMutation({
    mutationFn: () => evaluateAlertMatches({ persist: true }),
    onSuccess: async (result) => {
      toast.success(
        result.matchCount === 0
          ? "Aucune vente ne correspond à vos alertes pour le moment."
          : `${result.matchCount} vente${result.matchCount > 1 ? "s correspondent" : " correspond"} à vos alertes. Vous les recevrez dans votre prochain récapitulatif.`,
      );
      await client.invalidateQueries({ queryKey: alertsKey });
    },
    onError: (error) => toast.error(userMessage(error, "La recherche n’a pas abouti. Réessayez.")),
  });

  const alertList = alerts.data ?? [];
  return (
    <PageShell
      eyebrow="Mon espace"
      title="Mes alertes"
      description={
        <>
          Une alerte vous prévient quand une nouvelle vente correspond à vos critères. Vos alertes
          arrivent dans un seul email récapitulatif par jour. L’offre Découverte permet une alerte
          et une zone actives ; l’offre Analyse jusqu’à 25, avec des critères avancés.
        </>
      }
      actions={
        <Link href="/sales" className={buttonClasses({ variant: "dark" })}>
          Créer une alerte depuis le catalogue
        </Link>
      }
    >
      {(alerts.isPending || zones.isPending) && (
        <p role="status" className="text-ink-soft">
          Chargement de vos alertes…
        </p>
      )}
      {(alerts.isError || zones.isError) && (
        <Card role="alert" className="mb-6">
          <p className="font-semibold">Impossible de charger vos alertes pour le moment.</p>
          <Button
            className="mt-3"
            onClick={() => {
              void alerts.refetch();
              void zones.refetch();
            }}
          >
            Réessayer
          </Button>
        </Card>
      )}
      {alerts.data && (
        <section aria-label="Alertes enregistrées">
          <h2 className="font-display text-2xl font-semibold">Alertes enregistrées</h2>
          {alertList.length === 0 && (
            <Card className="mt-4 flex flex-col items-center gap-3 py-10 text-center">
              <Bell className="size-8 text-gold-text" aria-hidden />
              <p className="font-semibold">Aucune alerte enregistrée.</p>
              <p className="max-w-md text-ink-soft">
                Réglez vos filtres dans le catalogue, puis choisissez « Créer une alerte ».
              </p>
              <Link href="/sales" className={buttonClasses({ variant: "primary" })}>
                Voir les ventes
              </Link>
            </Card>
          )}
          <ul className="mt-4 grid gap-4">
            {alertList.map((alert) => (
              <li key={alert.id}>
                <AlertCard
                  alert={alert}
                  busy={mutation.isPending}
                  weeklyAllowed={weeklyAllowed}
                  editing={editingId === alert.id}
                  onEdit={() => setEditingId(alert.id)}
                  onCancelEdit={() => setEditingId(null)}
                  onAction={(action) => mutation.mutate(action)}
                />
              </li>
            ))}
          </ul>
          {alertList.some((a) => a.is_active) && (
            <div className="mt-5">
              <Button disabled={evaluation.isPending} onClick={() => evaluation.mutate()}>
                {evaluation.isPending ? "Recherche en cours…" : "Chercher les ventes maintenant"}
              </Button>
              <p className="mt-2 text-sm text-ink-soft">
                Les nouvelles ventes sont aussi recherchées automatiquement chaque jour.
              </p>
            </div>
          )}
        </section>
      )}
      {zones.data && (
        <section className="mt-10" aria-label="Zones surveillées">
          <h2 className="font-display text-2xl font-semibold">Zones surveillées</h2>
          {zones.data.zones.length === 0 && (
            <p className="mt-3 text-ink-soft">Aucune zone enregistrée.</p>
          )}
          <ul className="mt-4 grid gap-4">
            {zones.data.zones.map((zone) => (
              <li key={zone.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{zone.name}</h3>
                    <p className="text-sm text-ink-soft">
                      Supprimer la zone met en pause les alertes qui lui sont liées.
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        kind: "zone",
                        zone,
                        linkedAlerts: alertList.filter((a) => a.watched_zone_id === zone.id),
                      })
                    }
                  >
                    Supprimer la zone
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}
    </PageShell>
  );
}

function AlertCard({
  alert,
  busy,
  weeklyAllowed,
  editing,
  onEdit,
  onCancelEdit,
  onAction,
}: {
  alert: UserAlert;
  busy: boolean;
  weeklyAllowed: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onAction: (action: AlertAction) => void;
}) {
  const criteria = alertCriteriaSummary(alert);
  const frequency = normalizeAlertFrequency(alert.alert_frequency);
  return (
    <Card as="article" aria-label={alert.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-xl font-semibold">{alert.name}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={alert.is_active ? "success" : "neutral"}>
              {alert.is_active ? "Active" : "En pause"}
            </Badge>
            <Badge tone="gold">{ALERT_FREQUENCY_LABELS[frequency]}</Badge>
          </div>
        </div>
        <label className="text-sm">
          <span className="mb-1 block font-semibold">Fréquence</span>
          <select
            aria-label={`Fréquence de l’alerte ${alert.name}`}
            className="form-input min-h-11 pr-8"
            value={frequency}
            disabled={busy}
            onChange={(event) =>
              onAction({
                kind: "frequency",
                id: alert.id,
                frequency: event.target.value as AlertFrequency,
              })
            }
          >
            <option value="daily">{ALERT_FREQUENCY_LABELS.daily}</option>
            <option value="weekly" disabled={!weeklyAllowed && frequency !== "weekly"}>
              {ALERT_FREQUENCY_LABELS.weekly}
              {weeklyAllowed || frequency === "weekly" ? "" : " (offre Analyse)"}
            </option>
          </select>
        </label>
      </div>

      <div className="mt-4">
        <p className="text-sm font-semibold">Critères</p>
        {criteria.length ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {criteria.map((criterion) => (
              <li key={criterion}>
                <Badge>{criterion}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-ink-soft">Toutes les nouvelles ventes.</p>
        )}
        {alert.last_evaluated_at ? (
          <p className="mt-3 text-sm text-ink-soft">
            Dernière recherche : {formatDate(alert.last_evaluated_at)} ·{" "}
            {alert.last_match_count === 0
              ? "aucune vente trouvée"
              : `${alert.last_match_count} vente${alert.last_match_count > 1 ? "s" : ""} trouvée${alert.last_match_count > 1 ? "s" : ""}`}
          </p>
        ) : null}
      </div>

      {editing ? (
        <AlertEditForm
          alert={alert}
          busy={busy}
          weeklyAllowed={weeklyAllowed}
          onCancel={onCancelEdit}
          onSubmit={(patch) => onAction({ kind: "edit", id: alert.id, patch })}
        />
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={onEdit}>
            Modifier
          </Button>
          <Button
            disabled={busy}
            onClick={() => onAction({ kind: alert.is_active ? "pause" : "resume", id: alert.id })}
          >
            {alert.is_active ? "Mettre en pause" : "Réactiver"}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => onAction({ kind: "delete", alert })}
          >
            Supprimer l’alerte
          </Button>
        </div>
      )}
    </Card>
  );
}

function AlertEditForm({
  alert,
  busy,
  weeklyAllowed,
  onCancel,
  onSubmit,
}: {
  alert: UserAlert;
  busy: boolean;
  weeklyAllowed: boolean;
  onCancel: () => void;
  onSubmit: (
    patch: Pick<UserAlert, "name" | "alert_frequency" | "max_price_eur" | "min_surface_m2">,
  ) => void;
}) {
  const [name, setName] = useState(alert.name);
  const [frequency, setFrequency] = useState<AlertFrequency>(
    normalizeAlertFrequency(alert.alert_frequency),
  );
  const [maxPrice, setMaxPrice] = useState(alert.max_price_eur?.toString() ?? "");
  const [minSurface, setMinSurface] = useState(alert.min_surface_m2?.toString() ?? "");
  const toNumber = (value: string) => {
    const parsed = Number(value.replace(/\s/g, "").replace(",", "."));
    return value.trim() && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit({
      name: name.trim() || alert.name,
      alert_frequency: frequency,
      max_price_eur: toNumber(maxPrice),
      min_surface_m2: toNumber(minSurface),
    });
  }
  return (
    <form
      onSubmit={submit}
      className="mt-4 grid gap-3 rounded-lg border border-line bg-surface-tint p-4"
    >
      <label className="grid gap-1 text-sm font-semibold">
        Nom de l’alerte
        <input
          className="form-input"
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm font-semibold">
          Mise à prix maximale (€)
          <input
            className="form-input"
            inputMode="numeric"
            value={maxPrice}
            placeholder="Sans limite"
            onChange={(event) => setMaxPrice(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Surface minimale (m²)
          <input
            className="form-input"
            inputMode="numeric"
            value={minSurface}
            placeholder="Sans minimum"
            onChange={(event) => setMinSurface(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-sm font-semibold">
          Fréquence
          <select
            className="form-input"
            value={frequency}
            onChange={(event) => setFrequency(event.target.value as AlertFrequency)}
          >
            <option value="daily">{ALERT_FREQUENCY_LABELS.daily}</option>
            <option value="weekly" disabled={!weeklyAllowed && frequency !== "weekly"}>
              {ALERT_FREQUENCY_LABELS.weekly}
            </option>
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="dark" disabled={busy}>
          Enregistrer
        </Button>
        <Button onClick={onCancel}>Annuler</Button>
      </div>
    </form>
  );
}
