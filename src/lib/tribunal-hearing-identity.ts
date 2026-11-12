import { labelFingerprint } from "@/lib/label-fingerprint";
import { parisDateKey } from "@/lib/paris-time";
export { labelFingerprint };
// Repris par `tribunal-judicial-activity.ts`, qui le lisait ici avant `@/lib/paris-time`.
export { parisDateKey as parisDayKey };
/**
 * Conservative identity of one judicial lot across announcements.
 *
 * The same lot is routinely published by several sources (Licitor, Vench,
 * Petites Affiches, which itself exposes two URL schemes with different
 * identifiers). Measured in production on 2026-10-11, more than half of the
 * upcoming tribunal rows and of the archived past hearings were such copies.
 *
 * Two announcements are the same lot only when they share the court, the
 * hearing day in Europe/Paris, the exact positive starting price and the
 * normalized commune. A row without price or commune is never merged.
 */

export function hearingIdentityKey(input: {
  courtCode: string | null | undefined;
  saleAt: Date;
  startingPriceEur: number | null | undefined;
  city: string | null | undefined;
}): string | null {
  const courtCode = input.courtCode?.trim().toLocaleLowerCase("fr-FR");
  const price = input.startingPriceEur;
  const city = input.city ? labelFingerprint(input.city) : "";
  if (
    !courtCode ||
    !Number.isFinite(input.saleAt.getTime()) ||
    price == null ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !city
  ) {
    return null;
  }
  return [courtCode, parisDateKey(input.saleAt), Math.round(price * 100), city].join("|");
}
