import "server-only";

export function quantile(sortedValues: number[], percentile: number): number {
  if (!sortedValues.length) return 0;
  const position = (sortedValues.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (position - lower);
}

export function roundTo(value: number, precision: number): number {
  return Math.max(precision, Math.round(value / precision) * precision);
}

export function finiteFloat(value: string | undefined): number | null {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function finiteNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

export function monthDistance(older: Date, newer: Date): number {
  const years = newer.getUTCFullYear() - older.getUTCFullYear();
  const months = newer.getUTCMonth() - older.getUTCMonth();
  return years * 12 + months;
}

export function positiveNumber(value: number | null | undefined, minimum: number): number | null {
  return value != null && Number.isFinite(value) && value >= minimum ? value : null;
}

export function positiveInteger(value: number | null | undefined): number | null {
  return value != null && Number.isInteger(value) && value > 0 ? value : null;
}
