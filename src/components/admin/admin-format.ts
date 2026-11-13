import type { AuctionRun } from "@/lib/admin.server";
import { PARIS_TIME_ZONE } from "@/lib/paris-time";

export function queryErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat("fr-FR").format(value);
}

/** « 12 nov. 2026, 14:30 », heure de Paris. */
export function formatDateTime(value: string): string {
  return formatParisDate(value, { dateStyle: "medium", timeStyle: "short" });
}

/** « 12 nov. 2026 », jour de Paris. */
export function formatDate(value: string): string {
  return formatParisDate(value, { dateStyle: "medium" });
}

/** « 12/11 14:30 », heure de Paris : colonnes étroites des tableaux. */
export function formatShortDateTime(value: string): string {
  return formatParisDate(value, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Une valeur illisible est rendue telle quelle plutôt que de faire échouer l'écran. */
function formatParisDate(value: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", { ...options, timeZone: PARIS_TIME_ZONE }).format(date);
}

export function formatRelativeTime(value: string): string {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return "à l’instant";
  if (elapsedMinutes < 60) return `il y a ${elapsedMinutes} min`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return formatDateTime(value);
}

export function formatPrice(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Mise à prix à préciser";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function shortId(id: string): string {
  return id ? id.slice(0, 8) : "—";
}

export function runDuration(run: AuctionRun): string {
  if (!run.startedAt) return "durée inconnue";
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  const start = new Date(run.startedAt).getTime();
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  if (minutes < 1) return "moins d'une minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function summaryNumber(run: AuctionRun, key: string): string {
  const value = run.summary[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
}

export function errorCount(errors: Record<string, unknown>): number {
  let total = 0;
  for (const value of Object.values(errors)) {
    if (Array.isArray(value)) {
      total += value.length;
    } else if (value) {
      total += 1;
    }
  }
  return total;
}
