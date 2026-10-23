import type { AuctionScenario } from "@/lib/auction-scenarios";

/**
 * « Mon plafond face au tribunal » : où se situe l'enchère plafond de la personne dans les issues
 * observées des ventes comparables du tribunal (les `scenarios` de `/api/sales/[id]/auction-scenarios`).
 * Module pur.
 */

export type CeilingPosition =
  /** Le plafond est sous la mise à prix : aucune enchère n'est possible (une adjudication part de la mise à prix). */
  | { kind: "below_start" }
  | {
      kind: "share";
      /** Part (0 à 1) des ventes comparables adjugées à un prix strictement inférieur au plafond. */
      share: number;
      /**
       * Au-delà de la dernière tranche fermée (plus de 3 fois la mise à prix) on ne sait plus répartir
       * les prix : la part est alors un plancher (« au moins »).
       */
      atLeast: boolean;
      /** Le plafond en multiples de la mise à prix. */
      ratio: number;
    };

/**
 * Part des ventes adjugées au-dessous du plafond, par interpolation linéaire dans la tranche qui
 * contient le plafond (les prix y sont supposés répartis uniformément : une estimation). Une
 * adjudication ne peut pas être sous la mise à prix : la première tranche commence à 1 fois la mise
 * à prix, même si la base la note depuis 0. Sans tranche exploitable, `null` (aucun chiffre).
 */
export function ceilingPosition(
  scenarios: readonly AuctionScenario[],
  ceiling: number,
  startingPrice: number,
): CeilingPosition | null {
  if (!(startingPrice > 0) || !Number.isFinite(ceiling) || ceiling <= 0) return null;
  const buckets = [...scenarios].sort((a, b) => a.lowRatio - b.lowRatio);
  const total = buckets.reduce((sum, bucket) => sum + bucket.probability, 0);
  if (!(total > 0)) return null;

  const ratio = ceiling / startingPrice;
  if (ratio < 1) return { kind: "below_start" };

  let below = 0;
  for (const [index, bucket] of buckets.entries()) {
    const low = index === 0 ? Math.max(bucket.lowRatio, 1) : bucket.lowRatio;
    if (ratio <= low) break;
    if (bucket.highRatio == null)
      return { kind: "share", share: below / total, atLeast: true, ratio };
    if (ratio >= bucket.highRatio) {
      below += bucket.probability;
      continue;
    }
    below += (bucket.probability * (ratio - low)) / (bucket.highRatio - low);
    break;
  }
  return { kind: "share", share: Math.min(1, below / total), atLeast: false, ratio };
}
