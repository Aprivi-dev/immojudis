import { formatDateTime } from "@/lib/format/dates";
import { finiteNumberFromNumberOrText as num } from "@/lib/finite-number";

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

/** Part des ventes à venir dont l'enchère plafond est calculable, pour un type de vente (P7). */
export type CeilingCoverageRow = {
  key: string;
  label: string;
  /** Ventes à venir évaluées (« 412 »). */
  upcoming: string;
  /** Ventes dont le plafond est calculable, avec leur part (« 230 (55,8 %) »). */
  computable: string;
  /** Part calculable, de 0 à 1 ; null sans vente à venir. */
  ratio: number | null;
  /** Motif d'échec le plus fréquent (« Surface absente : 64 ventes »), ou null sans échec. */
  mainFailure: string | null;
};

export type CeilingCoverageView = {
  rows: CeilingCoverageRow[];
  /** Tous types de vente confondus. */
  total: CeilingCoverageRow;
  /** D'où vient la mesure et quand. */
  note: string;
};

/** Doublons entre sources encore au catalogue (D12, affichage seulement). */
export type CrossSourceDuplicatesView = {
  groups: string;
  lines: string;
  /** Seuils de l'alerte `catalogue.duplicates.cross_source`, tels que la base les définit. */
  threshold: string;
  state: CatalogueQualityState;
  stateLabel: string;
  threeSourceGroups: string;
  /** Les premiers groupes à trois sources ou plus (« 12/12/2026 · lyon · 95 000 € · 3 sources, 3 lignes »). */
  threeSourceExamples: string[];
  /** Origine de la mesure (fonction de la base, ou dernier passage de l'alerte avant la migration). */
  note: string;
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
  /** Null : mesure indisponible (lecture en échec ou aucune évaluation). */
  ceilingCoverage?: CeilingCoverageView | null;
  /** Null : mesure indisponible (fonction de la base pas encore déployée et aucune alerte passée). */
  crossSourceDuplicates?: CrossSourceDuplicatesView | null;
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

// ------------------------------------------------------------------------------------------------------------
// P7 : part des ventes à venir dont l'enchère plafond est calculable, par type de vente.
//
// Lecture des évaluations de pépite (`auction_sale_pepites`, recalculées toutes les quelques heures par
// /api/cron/sale-pepites, en mode « shadow » comme « on ») : le critère `ceiling_computed` y est réussi quand le
// plafond de la vente est chiffré par le chemin de la fiche (`computeSaleCeiling`, sur la valeur prudente). Les
// ventes à venir sont celles dont l'évaluation a réussi `sale_upcoming` et dont la date n'est pas passée depuis.
// Le motif d'échec vient des critères manqués, puis de l'état de l'estimation stockée de la vente. Une surface
// saisie par un utilisateur (« Mon dossier ») n'entre jamais dans cette mesure.
// ------------------------------------------------------------------------------------------------------------

/** Une évaluation lue, réduite à ce que la mesure utilise. */
export type CeilingCoverageSale = {
  reasonCodes: readonly string[];
  venueType: string | null;
  saleDate: string | null;
  /** État de l'estimation stockée (`auction_sale_market_estimates.status`), null sans ligne. */
  estimateStatus: string | null;
  estimateErrorCode: string | null;
};

export const CEILING_FAILURE_LABELS: Record<string, string> = {
  regime_closed: "Type de vente non ouvert au calcul",
  valuation_conflict: "Conflit de valorisation",
  ai_block: "Donnée bloquée par la relecture IA",
  missing_surface: "Surface absente",
  no_comparables: "Pas assez de ventes comparables",
  missing_location: "Adresse non localisée",
  unsupported_segment: "Type de bien non estimé",
  estimate_pending: "Estimation en attente",
  estimate_not_actionable: "Estimation non exploitable",
  estimate_failed: "Estimation en échec",
  other: "Autre motif (plafond nul ou sous la première offre)",
};

const VENUES: ReadonlyArray<readonly [key: string, label: string]> = [
  ["tribunal", "Tribunal"],
  ["notary", "Notaire"],
  ["state", "État (domaine)"],
  ["other", "Autre ou inconnu"],
];

function venueKey(value: string | null): string {
  return value === "tribunal" || value === "notary" || value === "state" ? value : "other";
}

/** Motif principal pour lequel le plafond d'une vente n'est pas calculable. */
export function ceilingFailureReason(sale: CeilingCoverageSale): string {
  const codes = new Set(sale.reasonCodes);
  if (codes.has("fail:regime_open")) return "regime_closed";
  if (codes.has("fail:no_valuation_conflict")) return "valuation_conflict";
  if (codes.has("fail:no_ai_block")) return "ai_block";
  if (codes.has("pass:estimate_actionable")) return "other";
  switch (sale.estimateErrorCode) {
    case "MISSING_SURFACE":
      return "missing_surface";
    case "NO_COMPARABLES":
      return "no_comparables";
    case "MISSING_LOCATION":
      return "missing_location";
    case "UNSUPPORTED_SEGMENT":
      return "unsupported_segment";
  }
  if (sale.estimateStatus == null) return "estimate_pending";
  if (sale.estimateStatus === "pending" || sale.estimateStatus === "processing") {
    return "estimate_pending";
  }
  if (sale.estimateStatus === "ready") return "estimate_not_actionable";
  if (sale.estimateStatus === "insufficient_data") return "no_comparables";
  return "estimate_failed";
}

const computed = (sale: CeilingCoverageSale) => sale.reasonCodes.includes("pass:ceiling_computed");

function coverageRow(key: string, label: string, sales: CeilingCoverageSale[]): CeilingCoverageRow {
  const computable = sales.filter(computed).length;
  const failures = new Map<string, number>();
  for (const sale of sales) {
    if (computed(sale)) continue;
    const reason = ceilingFailureReason(sale);
    failures.set(reason, (failures.get(reason) ?? 0) + 1);
  }
  // Le motif le plus fréquent ; à égalité, l'ordre des libellés (déterministe).
  const order = Object.keys(CEILING_FAILURE_LABELS);
  const main = [...failures.entries()].sort(
    ([left, a], [right, b]) => b - a || order.indexOf(left) - order.indexOf(right),
  )[0];
  const ratio = sales.length > 0 ? computable / sales.length : null;
  return {
    key,
    label,
    upcoming: integer(sales.length),
    computable: ratio == null ? "—" : `${integer(computable)} (${percent(ratio)})`,
    ratio,
    mainFailure: main
      ? `${CEILING_FAILURE_LABELS[main[0]]} : ${integer(main[1])} vente${main[1] > 1 ? "s" : ""}`
      : null,
  };
}

/** Mesure P7 à partir des évaluations lues ; null quand aucune vente à venir n'est évaluée. */
export function buildCeilingCoverage(
  sales: readonly CeilingCoverageSale[],
  now: Date = new Date(),
): CeilingCoverageView | null {
  const upcoming = sales.filter((sale) => {
    if (!sale.reasonCodes.includes("pass:sale_upcoming")) return false;
    const date = sale.saleDate ? Date.parse(sale.saleDate) : Number.NaN;
    return !Number.isFinite(date) || date > now.getTime();
  });
  if (upcoming.length === 0) return null;
  const rows = VENUES.map(([key, label]) =>
    coverageRow(
      key,
      label,
      upcoming.filter((sale) => venueKey(sale.venueType) === key),
    ),
  ).filter((row) => row.key !== "other" || row.ratio != null);
  return {
    rows,
    total: coverageRow("total", "Tous types", upcoming),
    note: `Mesure du ${formatDateTime(now.toISOString())}, d’après les dernières évaluations du traitement des pépites (critère « plafond calculé »). Une surface saisie par un utilisateur n’y entre pas.`,
  };
}

// ------------------------------------------------------------------------------------------------------------
// D12 (affichage seulement) : doublons entre sources encore visibles, même définition que
// app_private.cross_source_duplicate_groups (20261110120400) : même jour, même mise à prix, même ville
// normalisée, au moins deux sources. Les seuils de l'alerte restent ceux de la base ; la fusion reste coupée.
// ------------------------------------------------------------------------------------------------------------

export type CrossSourceDuplicateGroup = {
  sale_day: string;
  starting_price_eur: number | string;
  city_key: string;
  line_count: number | string;
  source_count: number | string;
};

export type CrossSourceDuplicatesPayload = {
  groups?: unknown;
  lines?: unknown;
  thresholds?: unknown;
  warning_groups?: unknown;
  critical_groups?: unknown;
  three_source_groups?: unknown;
  three_source_examples?: CrossSourceDuplicateGroup[] | null;
};

const euros = (value: number) =>
  new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);

function dayText(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

/**
 * Vue D12 : `payload` vient de public.admin_cross_source_duplicates_summary (migration 20261112100100) ou, tant
 * qu'elle n'est pas appliquée, du détail du dernier passage de l'alerte `catalogue.duplicates.cross_source`
 * (`source` dit lequel ; ce détail porte les seuils à plat). Null sans mesure.
 */
export function buildCrossSourceDuplicates(
  payload: CrossSourceDuplicatesPayload | null,
  source: { kind: "function" } | { kind: "alert"; seenAt: string },
): CrossSourceDuplicatesView | null {
  if (!payload) return null;
  const groups = num(payload.groups);
  if (groups == null) return null;
  const lines = num(payload.lines);
  const thresholds = record(payload.thresholds);
  const warning = num(thresholds.warning_groups ?? payload.warning_groups);
  const critical = num(thresholds.critical_groups ?? payload.critical_groups);
  const state: CatalogueQualityState =
    warning == null ? "trend" : groups >= warning ? "alert" : "ok";
  const threeSources = num(payload.three_source_groups);
  return {
    groups: integer(groups),
    lines: lines == null ? "—" : integer(lines),
    threshold:
      warning == null
        ? "Seuil inconnu"
        : `Alerte à partir de ${integer(warning)} groupes${critical == null ? "" : ` (critique : ${integer(critical)})`}`,
    state,
    stateLabel: STATE_LABELS[state],
    threeSourceGroups: threeSources == null ? "—" : integer(threeSources),
    threeSourceExamples: (payload.three_source_examples ?? []).map((group) => {
      const price = num(group.starting_price_eur);
      return [
        dayText(group.sale_day),
        group.city_key,
        price == null ? "—" : euros(price),
        `${integer(num(group.source_count) ?? 0)} sources, ${integer(num(group.line_count) ?? 0)} lignes`,
      ].join(" · ");
    }),
    note:
      source.kind === "function"
        ? "Mesure à l’instant, même définition que l’alerte. La fusion des doublons reste coupée."
        : `Dernier passage de l’alerte le ${formatDateTime(source.seenAt)} : la mesure à l’instant attend la migration 20261112100100. La fusion des doublons reste coupée.`,
  };
}
