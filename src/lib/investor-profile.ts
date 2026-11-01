import type { CeilingUserChoices } from "@/lib/bid-ceiling-defaults";
import { MAX_SIMULATOR_AMOUNT_EUR } from "@/lib/simulator-limits";

/**
 * Profil d'investisseur du compte (n° 93) : quatre hypothèses choisies une fois, reprises dans le
 * calcul de l'enchère plafond de chaque vente. La personne les modifie vente par vente, comme avant :
 * le profil ne fait que remplacer les hypothèses de départ du calcul.
 *
 * Donnée personnelle de nature financière (table `user_investor_profiles`, migration 20261110160100) :
 * propriétaire seul, jamais envoyée par email ni exportée. Chaque valeur est facultative et une valeur
 * absente reste absente.
 *
 * Ce module est importé par des composants du navigateur : pas de zod ici (voir
 * `investor-profile-input.ts`).
 */

export const INVESTOR_STRATEGIES = ["revendre", "louer"] as const;
export type InvestorStrategy = (typeof INVESTOR_STRATEGIES)[number];

export const INVESTOR_STRATEGY_LABELS: Record<InvestorStrategy, string> = {
  revendre: "Revendre",
  louer: "Louer",
};

/** Bornes de la base (contraintes de `user_investor_profiles`) et du calcul du plafond. */
export const INVESTOR_MARGIN_MAX_PCT = 50;
export const INVESTOR_WORKS_PER_M2_MAX_EUR = 10_000;
export const INVESTOR_DOWN_PAYMENT_MAX_EUR = MAX_SIMULATOR_AMOUNT_EUR;

export type InvestorProfile = {
  /** Apport personnel, en euros. */
  downPaymentEur: number | null;
  /** Marge cible, en pourcentage (0 à 50). */
  targetMarginPct: number | null;
  /** Budget travaux, en euros par mètre carré. */
  worksPerM2Eur: number | null;
  strategy: InvestorStrategy | null;
};

export type InvestorProfileResponse = { profile: InvestorProfile | null };
export type InvestorProfileDeleteResponse = { ok: true; removed: boolean };

export type InvestorProfileRow = {
  down_payment_eur: number | null;
  target_margin_pct: number | null;
  works_per_m2_eur: number | null;
  strategy: string | null;
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function toInvestorProfile(row: InvestorProfileRow): InvestorProfile {
  return {
    downPaymentEur: numberOrNull(row.down_payment_eur),
    targetMarginPct: numberOrNull(row.target_margin_pct),
    worksPerM2Eur: numberOrNull(row.works_per_m2_eur),
    strategy: (INVESTOR_STRATEGIES as readonly string[]).includes(row.strategy ?? "")
      ? (row.strategy as InvestorStrategy)
      : null,
  };
}

/** Vrai quand le profil ne contient aucune hypothèse. */
export function investorProfileIsEmpty(profile: InvestorProfile | null | undefined): boolean {
  return (
    !profile ||
    (profile.downPaymentEur == null &&
      profile.targetMarginPct == null &&
      profile.worksPerM2Eur == null &&
      profile.strategy == null)
  );
}

/**
 * Les hypothèses de départ du plafond d'une vente tirées du profil. Les choix propres à la vente
 * passent toujours devant (voir `useCeilingChoices`).
 *
 * - stratégie : le projet du plafond (revendre ou louer) ;
 * - marge cible : la marge du calcul ;
 * - travaux au mètre carré : un budget travaux, seulement si la surface de la vente est connue (on ne
 *   multiplie jamais par une surface inventée) ;
 * - l'apport n'entre pas dans le calcul du plafond : il préremplit le simulateur de financement
 *   (`investorProfileFinancingDraft`).
 */
export function investorProfileToChoices(
  profile: InvestorProfile | null | undefined,
  { surfaceM2 }: { surfaceM2: number | null | undefined },
): CeilingUserChoices {
  if (!profile) return {};
  const choices: CeilingUserChoices = {};
  if (profile.strategy) choices.project = profile.strategy;
  if (profile.targetMarginPct != null) choices.customMarginPct = profile.targetMarginPct;
  if (
    profile.worksPerM2Eur != null &&
    typeof surfaceM2 === "number" &&
    Number.isFinite(surfaceM2) &&
    surfaceM2 > 0
  ) {
    const amount = Math.round(surfaceM2 * profile.worksPerM2Eur);
    choices.works = amount > 0 ? { key: "devis", amount } : { key: "aucun", amount: 0 };
  }
  return choices;
}

/** L'apport du profil pour le simulateur de financement, ou `null` sans apport. */
export function investorProfileFinancingDraft(
  profile: InvestorProfile | null | undefined,
): { downPayment: number } | null {
  return profile?.downPaymentEur != null && profile.downPaymentEur > 0
    ? { downPayment: profile.downPaymentEur }
    : null;
}

export type ProfileNumberResult =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

/**
 * Lit un montant ou un pourcentage saisi dans le formulaire du profil : espaces (dont insécables) et
 * symboles ignorés, virgule ou point décimal. Un champ vide est une valeur absente (`null`), pas une
 * erreur : chaque hypothèse est facultative. Un point suivi de trois chiffres (« 185.000 ») est refusé.
 */
export function parseProfileNumber(
  raw: string,
  { max, label, decimals }: { max: number; label: string; decimals: boolean },
): ProfileNumberResult {
  const cleaned = raw.replace(/[\s\u00a0\u202f€%]/g, "").replace(",", ".");
  if (cleaned === "") return { ok: true, value: null };
  const pattern = decimals ? /^\d+(?:\.\d{1,2})?$/ : /^\d+$/;
  if (!pattern.test(cleaned)) {
    return {
      ok: false,
      message: `${label} : saisissez un nombre${decimals ? "" : " entier"}, en chiffres seulement.`,
    };
  }
  const value = decimals ? Math.round(Number(cleaned) * 100) / 100 : Number(cleaned);
  if (value > max) {
    return {
      ok: false,
      message: `${label} : le maximum est ${new Intl.NumberFormat("fr-FR").format(max)}.`,
    };
  }
  return { ok: true, value };
}
