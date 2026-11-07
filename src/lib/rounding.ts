/** Arrondit `value` à `digits` décimales. */
export function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function roundWithEpsilon(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

export function roundToTenth(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

export function averageRoundedToTenth(values: number[]): number | null {
  if (!values.length) return null;
  return roundToTenth(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function averageRounded(values: number[], digits = 0): number | null {
  if (!values.length) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, digits);
}
