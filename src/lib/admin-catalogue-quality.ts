import { formatDateTime } from "@/lib/format/dates";

/**
 * Panneau « Contrôles qualité du catalogue » de /admin/quality : la sentinelle de qualité (migration
 * 20261111100000_catalogue_quality_sentinel) mesure les ventes en ligne, ouvre les alertes `catalogue.quality.*`
 * et enregistre un cliché quotidien dans `auction_pipeline_observations` (`source_name = 'catalogue-quality'`,
 * seuils compris). Ce module met ce cliché et les alertes ouvertes en forme côté serveur : libellés, nombres,
 * seuils et état (au-dessus du seuil ou non) arrivent prêts à afficher, le navigateur ne fait que les poser
 * (budget JavaScript presque épuisé, voir `scripts/check-build-budgets.mjs`). Module pur, sans donnée ni import
 * serveur.
 *
 * Les états reprennent les règles d'`app_private.evaluate_catalogue_quality_health` : invariants et prix au m²
 * dès 1 vente, part sans code postal au-dessus du maximum à partir du nombre minimal de ventes en ligne, pièces
 * incomplètes au-delà du maximum. Les deux mesures de tendance n'ont pas de seuil.
 */

/** ok : sous le seuil ; alert : au-dessus ; trend : mesure de tendance sans seuil ; unknown : non mesuré. */
export type CatalogueQualityState = "ok" | "alert" | "trend" | "unknown";

export type CatalogueQualityRow = {
  key: string;
  label: string;
  /** Nombre du cliché, déjà mis en forme (« 32 (3,7 %) »). */
  count: string;
  threshold: string;
  state: CatalogueQualityState;
  stateLabel: string;
  /** Précision en petits caractères (ventes reconnues, prix le plus haut), ou null. */
  note: string | null;
};

export type CatalogueQualityAlert = {
  key: string;
  label: string;
  /** « Ouverte le …, vue le … ». */
  seen: string;
  /** Nombre au dernier passage (les alertes sont réévaluées toutes les 30 minutes). */
  detail: string;
};

export type AdminCatalogueQualityView = {
  /** Null tant qu'aucun cliché n'a été écrit. */
  snapshot: {
    observedAt: string;
    /** « Cliché du 05 novembre 2026 à 01:00 », ou la mention d'un cliché d'un jour précédent. */
    title: string;
    /** Le cliché date du jour (UTC) : sinon l'évaluation du jour n'a pas encore tourné. */
    isToday: boolean;
    liveSales: string;
    rows: CatalogueQualityRow[];
  } | null;
  alerts: CatalogueQualityAlert[];
};

export type CatalogueQualitySnapshotRow = { observed_at: string; metrics: unknown };
export type CatalogueQualityAlertRow = {
  alert_key: string;
  first_seen_at: string;
  last_seen_at: string;
  details: unknown;
};

export const CATALOGUE_QUALITY_SOURCE_NAME = "catalogue-quality";
export const CATALOGUE_QUALITY_ALERT_PREFIX = "catalogue.quality.";

/** Libellés, dans l'ordre d'affichage : les invariants, les seuils, puis les tendances. */
export const CATALOGUE_QUALITY_LABELS: Record<string, string> = {
  bedrooms_ge_rooms: "Chambres ≥ pièces (plus d’une pièce)",
  land_with_rooms: "Terrains avec un nombre de pièces",
  licitor_lot_mismatch: "Lots Licitor discordants avec leur carte",
  price_per_m2_implausible: "Prix au m² invraisemblable",
  missing_postal_code_ratio: "Ventes sans code postal",
  documents_incomplete: "Pièces jointes bloquées « incomplete »",
  dwelling_without_surface_ratio: "Maisons et appartements sans surface",
  occupancy_unknown_ratio: "Occupation inconnue",
};

const INVARIANTS = new Set(["bedrooms_ge_rooms", "land_with_rooms", "licitor_lot_mismatch"]);
const TRENDS = new Set(["dwelling_without_surface_ratio", "occupancy_unknown_ratio"]);
const PRICE_PER_M2 = "price_per_m2_implausible";
const POSTAL_CODE_RATIO = "missing_postal_code_ratio";
const STATE_LABELS: Record<CatalogueQualityState, string> = {
  ok: "Sous le seuil",
  alert: "Au-dessus du seuil",
  trend: "Tendance",
  unknown: "Non mesuré",
};

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function num(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

const integer = (value: number) => new Intl.NumberFormat("fr-FR").format(value);
const percent = (ratio: number) =>
  new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1 }).format(ratio);

function countText(metric: Json): string {
  const count = num(metric.count);
  if (count == null) return "—";
  const ratio = num(metric.ratio);
  return ratio == null ? integer(count) : `${integer(count)} (${percent(ratio)})`;
}

function row(
  key: string,
  metric: Json,
  threshold: string,
  state: CatalogueQualityState,
  note: string | null = null,
): CatalogueQualityRow {
  const measured = num(metric.count) != null;
  const finalState = measured ? state : "unknown";
  return {
    key,
    label: CATALOGUE_QUALITY_LABELS[key] ?? key,
    count: countText(metric),
    threshold,
    state: finalState,
    stateLabel: STATE_LABELS[finalState],
    note,
  };
}

/** Lignes du panneau à partir des mesures et des seuils enregistrés dans le cliché. */
export function catalogueQualityRows(metricsPayload: unknown): CatalogueQualityRow[] {
  const payload = record(metricsPayload);
  const metrics = record(payload.metrics);
  const thresholds = record(payload.thresholds);
  const liveSales = num(payload.live_sales);

  return Object.keys(CATALOGUE_QUALITY_LABELS).map((key) => {
    const metric = record(metrics[key]);
    const count = num(metric.count) ?? 0;
    if (INVARIANTS.has(key)) {
      return row(key, metric, "Alerte dès 1 vente", count > 0 ? "alert" : "ok");
    }
    if (TRENDS.has(key)) return row(key, metric, "Suivi sans alerte", "trend");
    if (key === PRICE_PER_M2) {
      const max = num(thresholds.price_per_m2_max_eur);
      const acknowledged = num(metric.acknowledged) ?? 0;
      const highest = num(metric.highest_eur_per_m2);
      const notes = [
        highest != null ? `jusqu’à ${integer(highest)} €/m²` : null,
        acknowledged === 1 ? "1 vente reconnue légitime, non comptée" : null,
        acknowledged > 1
          ? `${integer(acknowledged)} ventes reconnues légitimes, non comptées`
          : null,
      ].filter((part): part is string => part != null);
      return row(
        key,
        metric,
        max == null ? "Alerte dès 1 vente" : `Alerte dès 1 vente au-dessus de ${integer(max)} €/m²`,
        count > 0 ? "alert" : "ok",
        notes.length > 0 ? notes.join(" · ") : null,
      );
    }
    if (key === POSTAL_CODE_RATIO) {
      const max = num(thresholds.missing_postal_code_ratio_max);
      const minimum = num(thresholds.ratio_minimum_live_sales);
      const ratio = num(metric.ratio);
      if (max == null || minimum == null) return row(key, metric, "Seuil inconnu", "unknown");
      const active = liveSales != null && liveSales >= minimum;
      return row(
        key,
        metric,
        `Alerte au-dessus de ${percent(max)} (dès ${integer(minimum)} ventes en ligne)`,
        active && ratio != null && ratio > max ? "alert" : "ok",
        active ? null : `Moins de ${integer(minimum)} ventes en ligne : la part n’alerte pas.`,
      );
    }
    // documents_incomplete
    const max = num(thresholds.documents_incomplete_max_sales);
    const days = num(thresholds.documents_incomplete_minimum_age_days);
    if (max == null) return row(key, metric, "Seuil inconnu", "unknown");
    return row(
      key,
      metric,
      `Alerte au-delà de ${integer(max)} ventes`,
      count > max ? "alert" : "ok",
      days == null ? null : `Pièce « incomplete » connue depuis plus de ${integer(days)} jours.`,
    );
  });
}

function sameUtcDay(left: Date, right: Date): boolean {
  return left.toISOString().slice(0, 10) === right.toISOString().slice(0, 10);
}

/** Vue complète : dernier cliché (ou null) et alertes `catalogue.quality.*` ouvertes. */
export function buildAdminCatalogueQualityView(
  snapshot: CatalogueQualitySnapshotRow | null,
  alerts: CatalogueQualityAlertRow[],
  now: Date = new Date(),
): AdminCatalogueQualityView {
  const observed = snapshot ? new Date(snapshot.observed_at) : null;
  const isToday =
    observed != null && !Number.isNaN(observed.getTime()) && sameUtcDay(observed, now);
  const liveSales = snapshot ? num(record(snapshot.metrics).live_sales) : null;

  return {
    snapshot: snapshot
      ? {
          observedAt: snapshot.observed_at,
          title: isToday
            ? `Cliché du ${formatDateTime(snapshot.observed_at)}`
            : `Pas encore de cliché aujourd’hui : dernier cliché du ${formatDateTime(snapshot.observed_at)}`,
          isToday,
          liveSales: liveSales == null ? "—" : integer(liveSales),
          rows: catalogueQualityRows(snapshot.metrics),
        }
      : null,
    alerts: alerts.map((alert) => {
      const key = alert.alert_key.startsWith(CATALOGUE_QUALITY_ALERT_PREFIX)
        ? alert.alert_key.slice(CATALOGUE_QUALITY_ALERT_PREFIX.length)
        : alert.alert_key;
      const details = record(alert.details);
      const count = countText(details);
      return {
        key: alert.alert_key,
        label: CATALOGUE_QUALITY_LABELS[key] ?? alert.alert_key,
        seen: `Ouverte le ${formatDateTime(alert.first_seen_at)}, vue le ${formatDateTime(alert.last_seen_at)}`,
        detail: count === "—" ? "Nombre non précisé" : `${count} au dernier passage`,
      };
    }),
  };
}
