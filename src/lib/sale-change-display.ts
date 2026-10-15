import { formatPrice } from "@/lib/format";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";

/**
 * Wording of the changes detected on the sales an account follows (« Mes favoris »).
 *
 * Browser-safe: only types come from `sale-change-monitor` (which is server-only). The events are
 * produced by the monitor from the collected announcements; the date shown is the day the change
 * was DETECTED, not the day the announcement changed.
 */

/** A change older than this is no longer « récent ». */
export const RECENT_SALE_CHANGE_DAYS = 30;
/** Number of changes listed at most. */
export const MAX_DISPLAYED_SALE_CHANGES = 10;

export type SaleChangeTopic = "price" | "date" | "status" | "documents";

export type DescribedSaleChange = {
  event: SaleChangeEventSummary;
  topic: SaleChangeTopic;
  /** What changed, in one sentence fragment: « Mise à prix abaissée ». */
  label: string;
  /** Previous and current value: « 120 000 € → 100 000 € ». `null` when there is nothing to add. */
  detail: string | null;
};

const PARIS_TIME_ZONE = "Europe/Paris";

function longDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: PARIS_TIME_ZONE,
  }).format(date);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const STATUS_LABELS: Record<string, { label: string; detail: string | null }> = {
  postponed: { label: "Vente reportée", detail: "Nouvelle date à confirmer." },
  cancelled: { label: "Vente annulée", detail: null },
  canceled: { label: "Vente annulée", detail: null },
  withdrawn: { label: "Vente retirée", detail: null },
  adjudicated: { label: "Vente adjugée", detail: null },
  past: { label: "Date de la vente passée", detail: null },
  upcoming: { label: "Vente à nouveau à venir", detail: null },
};

const DOCUMENT_LABELS = new Set([
  "Nouveau document détecté",
  "Document retiré",
  "Documents modifiés",
]);

/**
 * The sentence of one event, or `null` for a kind that is not shown. The wording is built from the
 * event kind and its values, never from free text: an unknown value falls back to a neutral label.
 *
 * - `score_changed` is not shown: a score moves with the models, not with the sale, and would be
 *   the main source of false alerts.
 * - `hidden` lists the topics whose values must stay masked (a value held back by the review of
 *   the fiche): the label stays, the previous and current values are replaced by a notice.
 */
export function describeSaleChange(
  event: SaleChangeEventSummary,
  hidden: ReadonlySet<SaleChangeTopic> = new Set(),
): DescribedSaleChange | null {
  const previous = event.changeSummary.previousValue;
  const current = event.changeSummary.currentValue;

  switch (event.eventKind) {
    case "price_changed": {
      const before = finiteNumber(previous);
      const after = finiteNumber(current);
      const label =
        before != null && after != null && after < before
          ? "Mise à prix abaissée"
          : before != null && after != null && after > before
            ? "Mise à prix augmentée"
            : "Mise à prix modifiée";
      const detail = hidden.has("price")
        ? "Montants à confirmer."
        : before != null && after != null
          ? `${formatPrice(before)} → ${formatPrice(after)}`
          : null;
      return { event, topic: "price", label, detail };
    }
    case "audience_changed": {
      const before = longDay(previous);
      const after = longDay(current);
      const detail = hidden.has("date")
        ? "Dates à confirmer."
        : before && after
          ? `${before} → ${after}`
          : null;
      return { event, topic: "date", label: "Date de la vente modifiée", detail };
    }
    case "status_changed": {
      const known = typeof current === "string" ? STATUS_LABELS[current.toLowerCase()] : undefined;
      return {
        event,
        topic: "status",
        label: known?.label ?? "Statut de la vente modifié",
        detail: known?.detail ?? null,
      };
    }
    case "documents_changed":
      return {
        event,
        topic: "documents",
        label: DOCUMENT_LABELS.has(event.summaryLabel) ? event.summaryLabel : "Documents modifiés",
        detail: null,
      };
    default:
      return null;
  }
}

/**
 * The recent changes of the followed sales, newest first.
 *
 * - Only the sales in `saleIds` (the favorites of the page): the monitor also watches alert
 *   matches and workspaces.
 * - The same change is recorded once per watch (favorite, alert match, workspace): it is listed
 *   once per sale.
 * - Dismissed events and events older than {@link RECENT_SALE_CHANGE_DAYS} days are left out.
 */
export function recentSaleChanges(
  events: readonly SaleChangeEventSummary[],
  saleIds: ReadonlySet<string>,
  {
    now = new Date(),
    hiddenTopics = () => new Set<SaleChangeTopic>(),
  }: { now?: Date; hiddenTopics?: (saleId: string) => ReadonlySet<SaleChangeTopic> } = {},
): DescribedSaleChange[] {
  const oldest = now.getTime() - RECENT_SALE_CHANGE_DAYS * 24 * 60 * 60 * 1000;
  const seen = new Set<string>();
  const described: DescribedSaleChange[] = [];

  const newestFirst = [...events].sort(
    (a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt),
  );
  for (const event of newestFirst) {
    if (!saleIds.has(event.saleId) || event.dismissedAt) continue;
    const detectedAt = Date.parse(event.detectedAt);
    if (!Number.isFinite(detectedAt) || detectedAt < oldest) continue;
    const key = `${event.saleId}|${event.fingerprint}`;
    if (seen.has(key)) continue;
    const change = describeSaleChange(event, hiddenTopics(event.saleId));
    if (!change) continue;
    seen.add(key);
    described.push(change);
  }
  return described;
}

/** « 14 octobre 2026 » (Paris) for the detection date, or `null` when it cannot be read. */
export function saleChangeDetectedOn(value: string): string | null {
  return longDay(value);
}
