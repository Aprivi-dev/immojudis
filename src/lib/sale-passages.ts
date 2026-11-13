import { parseFiniteNumber as finiteNumber } from "@/lib/finite-number";
import { formatDate } from "@/lib/format/dates";
import { formatPercent, formatPrice } from "@/lib/format/numbers";
/**
 * « Historique de la vente » : what happened to this listing (hearing moved,
 * starting price changed, postponed…) and the earlier passages of the same
 * property (same street number and street, commune, type and surface).
 * Shared by the API route (server) and the sale page (browser).
 */

type SaleTimelineKind =
  | "first_seen"
  | "sale_date_changed"
  | "starting_price_changed"
  | "postponed"
  | "cancelled"
  | "adjudicated";

export type SaleTimelineEvent = {
  kind: SaleTimelineKind;
  previous: unknown;
  value: unknown;
  observedAt: string;
  /** Rebuilt from the change log: the previous value may be unknown. */
  backfilled: boolean;
};

export type SalePreviousPassage = {
  saleDate: string;
  startingPriceEur: number | null;
  status: string | null;
};

export type SalePassagesSummary = {
  previousPassageCount: number;
  /** Starting price now vs the most recent earlier value (passage or listing change), in %. */
  priceChangePct: number | null;
  postponementCount: number;
};

export type SalePassagesResponse =
  | {
      access: "full";
      timeline: SaleTimelineEvent[];
      previousPassages: SalePreviousPassage[];
      summary: SalePassagesSummary;
    }
  /** Free accounts: the counts only, the details stay with the Analyse offer. */
  | { access: "teaser"; summary: SalePassagesSummary };

type RawPassages = {
  timeline?: Array<{
    kind?: string;
    previous?: unknown;
    value?: unknown;
    observed_at?: string;
    backfilled?: boolean;
  }>;
  previous_passages?: Array<{
    sale_date?: string;
    starting_price_eur?: number | string | null;
    status?: string | null;
  }>;
} | null;

const KINDS = new Set<SaleTimelineKind>([
  "first_seen",
  "sale_date_changed",
  "starting_price_changed",
  "postponed",
  "cancelled",
  "adjudicated",
]);

export function mapSalePassages(
  raw: RawPassages,
  currentStartingPrice: number | null,
): Extract<SalePassagesResponse, { access: "full" }> {
  const timeline = (raw?.timeline ?? [])
    .filter((event): event is NonNullable<typeof event> & { kind: SaleTimelineKind } =>
      KINDS.has(event?.kind as SaleTimelineKind),
    )
    .map((event) => ({
      kind: event.kind,
      previous: event.previous ?? null,
      value: event.value ?? null,
      observedAt: event.observed_at ?? "",
      backfilled: event.backfilled === true,
    }));
  const previousPassages = (raw?.previous_passages ?? [])
    .filter((passage) => typeof passage?.sale_date === "string")
    .map((passage) => ({
      saleDate: passage.sale_date as string,
      startingPriceEur: finiteNumber(passage.starting_price_eur),
      status: passage.status ?? null,
    }));
  return {
    access: "full",
    timeline,
    previousPassages,
    summary: summarizeSalePassages(timeline, previousPassages, currentStartingPrice),
  };
}

function summarizeSalePassages(
  timeline: SaleTimelineEvent[],
  previousPassages: SalePreviousPassage[],
  currentStartingPrice: number | null,
): SalePassagesSummary {
  const lastPriceChange = [...timeline]
    .reverse()
    .find((event) => event.kind === "starting_price_changed" && finiteNumber(event.previous));
  const reference =
    finiteNumber(lastPriceChange?.previous) ??
    previousPassages.find((passage) => passage.startingPriceEur)?.startingPriceEur ??
    null;
  const priceChangePct =
    reference && currentStartingPrice && reference !== currentStartingPrice
      ? Math.round(((currentStartingPrice - reference) / reference) * 100)
      : null;
  return {
    previousPassageCount: previousPassages.length,
    priceChangePct,
    postponementCount: timeline.filter((event) => event.kind === "postponed").length,
  };
}

/** Date d'une valeur JSON de l'historique ; `null` si ce n'est pas une date lisible. */
export function formatPassageDate(value: unknown): string | null {
  return typeof value === "string" ? formatDate(value, "") || null : null;
}

/** Montant d'une valeur JSON de l'historique ; `null` si ce n'est pas un nombre. */
function formatEuro(value: unknown): string | null {
  const parsed = finiteNumber(value);
  return parsed == null ? null : formatPrice(parsed);
}

function formatSignedPercent(pct: number): string {
  return `${pct > 0 ? "+" : ""}${formatPercent(pct)}`;
}

/** One line of the timeline, in plain French. */
export function describeTimelineEvent(event: SaleTimelineEvent): {
  title: string;
  detail: string | null;
} {
  switch (event.kind) {
    case "first_seen":
      return { title: "Annonce repérée par Immojudis", detail: null };
    case "sale_date_changed": {
      const from = formatPassageDate(event.previous);
      const to = formatPassageDate(event.value);
      return {
        title: "Date d’audience modifiée",
        detail: from && to ? `Du ${from} au ${to}` : to ? `Nouvelle date : ${to}` : null,
      };
    }
    case "starting_price_changed": {
      const from = finiteNumber(event.previous);
      const to = finiteNumber(event.value);
      const pct = from && to ? Math.round(((to - from) / from) * 100) : null;
      return {
        title:
          pct == null
            ? "Mise à prix modifiée"
            : pct < 0
              ? "Mise à prix baissée"
              : "Mise à prix relevée",
        detail:
          from && to
            ? `${formatEuro(from)} → ${formatEuro(to)} (${formatSignedPercent(pct!)})`
            : to
              ? `Nouvelle mise à prix : ${formatEuro(to)}`
              : null,
      };
    }
    case "postponed":
      return { title: "Vente reportée", detail: "Une nouvelle audience doit être fixée." };
    case "cancelled":
      return { title: "Vente annulée ou retirée", detail: null };
    case "adjudicated": {
      const price =
        event.value && typeof event.value === "object"
          ? formatEuro((event.value as Record<string, unknown>).adjudication_price_eur)
          : null;
      return { title: "Bien adjugé", detail: price ? `Prix d’adjudication : ${price}` : null };
    }
  }
}

export function describePreviousPassage(
  passage: SalePreviousPassage,
  currentStartingPrice: number | null,
): { title: string; detail: string | null } {
  const date = formatPassageDate(passage.saleDate) ?? "Date inconnue";
  const price = formatEuro(passage.startingPriceEur);
  const pct =
    passage.startingPriceEur && currentStartingPrice
      ? Math.round(
          ((currentStartingPrice - passage.startingPriceEur) / passage.startingPriceEur) * 100,
        )
      : null;
  return {
    title: `Audience du ${date}`,
    detail: price
      ? `Mise à prix ${price}${
          pct ? ` · aujourd’hui ${formatSignedPercent(pct)}` : " · même mise à prix qu’aujourd’hui"
        }`
      : null,
  };
}
