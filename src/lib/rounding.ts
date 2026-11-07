/** Arrondit `value` à `digits` décimales. */
export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function roundWithEpsilon(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
