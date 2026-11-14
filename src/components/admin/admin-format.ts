import type { AuctionRun } from "@/lib/admin.server";
import { formatShortDateTime } from "@/lib/format/dates";
import { PARIS_TIME_ZONE } from "@/lib/paris-time";

export function queryErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat("fr-FR").format(value);
}

/** « 12/11 14:30 », heure de Paris : colonnes étroites des tableaux. Une valeur illisible est rendue telle quelle. */
export function formatCompactDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: PARIS_TIME_ZONE,
  }).format(date);
}

export function formatRelativeTime(value: string): string {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 1) return "à l’instant";
  if (elapsedMinutes < 60) return `il y a ${elapsedMinutes} min`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return formatShortDateTime(value);
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

/** États d'une collecte (`auction_runs.status`) ; un autre état reste affiché tel quel. */
const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "En file",
  running: "En cours",
  succeeded: "Réussie",
  failed: "Échouée",
};

export function runStatusLabel(status: string): string {
  return Object.hasOwn(RUN_STATUS_LABELS, status) ? RUN_STATUS_LABELS[status] : status;
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
