import "server-only";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { SaleSignal } from "@/lib/sale-signal-feedback";

/**
 * Retours « Utile » / « Pas pertinent » sur les signaux d'une vente (point 67), lus pour la page admin
 * « Pilotage » par `admin_sale_signal_feedback_summary` (migration 20261030110300, puis 20261104100000 pour
 * le signal « pepite ») : par signal, le
 * nombre de retours, la part d'« Utile », les comptes distincts et les motifs, sur 90 jours. Nombres
 * exacts, aucun nom, aucune vente ; les « point faux » (motif `point_wrong` de la liste des points à
 * vérifier) y ont leur ligne.
 *
 * Même protection que le reste du pilotage : jeton de session vérifié, rôle administrateur, lecture avec
 * le client de service. Une mesure impossible (migration pas encore appliquée, panne) vaut `null` et
 * s'affiche « non mesuré », jamais zéro. La règle « moins de 5 » est une règle d'affichage de la page.
 */
/** Un nombre exact, ou `null` : « non mesuré » (comme `PilotageCount`). */
export type FeedbackCount = number | null;

export type SignalFeedbackCounts = {
  /** Retours, dont « Utile » et « Pas pertinent », et comptes distincts. */
  total: FeedbackCount;
  useful: FeedbackCount;
  notRelevant: FeedbackCount;
  accounts: FeedbackCount;
  /** Motifs : estimation trop haute ou trop basse (bande), point faux ou manquant (points à vérifier). */
  reasons: Record<string, FeedbackCount>;
  /**
   * Retours par version de la règle de la vente à la lecture (signal `pepite` seulement ; `unknown` : vente sans
   * ligne de pépite). Vide pour les autres signaux ou quand la migration 20261108180100 n'est pas appliquée.
   */
  ruleVersions: Record<string, number>;
};

export type SaleSignalFeedbackSummary = {
  generatedAt: string | null;
  windowDays: number;
  signals: Record<SaleSignal, SignalFeedbackCounts>;
};

const count = z.number().int().nonnegative().nullish();
const signalSchema = z.object({
  signal: z.string(),
  total: count,
  useful: count,
  not_relevant: count,
  accounts: count,
  reasons: z.record(z.string(), count).nullish(),
  rule_versions: z.record(z.string(), z.number().int().nonnegative()).nullish(),
});
const summarySchema = z.object({
  generated_at: z.string().nullish(),
  window_days: z.number().int().positive().nullish(),
  signals: z.array(signalSchema),
});

const REASON_KEYS: Record<SaleSignal, readonly string[]> = {
  market_gap_band: ["estimate_too_high", "estimate_too_low"],
  points_to_verify: ["point_wrong", "point_missing"],
  pepite: ["amount_too_high", "criterion_wrong", "not_interesting"],
};

const orNull = (value: number | null | undefined): FeedbackCount => value ?? null;

function unmeasuredCounts(signal: SaleSignal): SignalFeedbackCounts {
  return {
    total: null,
    useful: null,
    notRelevant: null,
    accounts: null,
    reasons: Object.fromEntries(REASON_KEYS[signal].map((key) => [key, null])),
    ruleVersions: {},
  };
}

/** Réponse quand rien n'a pu être mesuré : tout vaut « non mesuré », jamais zéro. */
export function unavailableSaleSignalFeedback(): SaleSignalFeedbackSummary {
  return {
    generatedAt: null,
    windowDays: 90,
    signals: {
      market_gap_band: unmeasuredCounts("market_gap_band"),
      points_to_verify: unmeasuredCounts("points_to_verify"),
      pepite: unmeasuredCounts("pepite"),
    },
  };
}

/** Lit la réponse JSON de `admin_sale_signal_feedback_summary`. Un signal absent vaut « non mesuré ». */
export function parseSaleSignalFeedbackSummary(raw: unknown): SaleSignalFeedbackSummary {
  const summary = summarySchema.parse(raw);
  const bySignal = new Map(summary.signals.map((entry) => [entry.signal, entry]));
  const read = (signal: SaleSignal): SignalFeedbackCounts => {
    const entry = bySignal.get(signal);
    if (!entry) return unmeasuredCounts(signal);
    return {
      total: orNull(entry.total),
      useful: orNull(entry.useful),
      notRelevant: orNull(entry.not_relevant),
      accounts: orNull(entry.accounts),
      reasons: Object.fromEntries(
        REASON_KEYS[signal].map((key) => [key, orNull(entry.reasons?.[key])]),
      ),
      ruleVersions: entry.rule_versions ?? {},
    };
  };
  return {
    generatedAt: summary.generated_at ?? null,
    windowDays: summary.window_days ?? 90,
    signals: {
      market_gap_band: read("market_gap_band"),
      points_to_verify: read("points_to_verify"),
      pepite: read("pepite"),
    },
  };
}

/** Fonction de base absente (migration pas encore appliquée) : rien n'est mesuré. */
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/** Comme `getAdminPilotage` : jeton et rôle administrateur vérifiés, puis lecture avec le client de service. */
export async function getAdminSaleSignalFeedback(
  authToken: string,
  now = new Date(),
): Promise<SaleSignalFeedbackSummary> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");

  const { data, error } = await supabaseAdmin.rpc("admin_sale_signal_feedback_summary", {
    p_now: now.toISOString(),
  });
  if (error) {
    if (isMissingFunction(error)) return unavailableSaleSignalFeedback();
    throw error;
  }
  return parseSaleSignalFeedbackSummary(data);
}

/** Un motif de retour négatif sur une vente : le nombre de « Pas pertinent », jamais un compte. */
export type SaleFeedbackBySaleRow = {
  saleId: string;
  title: string | null;
  city: string | null;
  department: string | null;
  signal: SaleSignal;
  /** Motif de la liste fermée du signal, ou `none` : « Pas pertinent » sans motif. */
  reason: string;
  count: number;
  lastAt: string | null;
  /** Version de la règle de la vente à la lecture (signal `pepite`) ; `null` sinon. */
  ruleVersion: string | null;
};

export type SaleFeedbackBySale = {
  generatedAt: string | null;
  windowDays: number;
  rows: SaleFeedbackBySaleRow[];
  /** Faux : la fonction de base est absente (migration pas encore appliquée), rien n'est mesuré. */
  measured: boolean;
};

const bySaleSchema = z.object({
  generated_at: z.string().nullish(),
  window_days: z.number().int().positive().nullish(),
  rows: z.array(
    z.object({
      sale_id: z.string(),
      title: z.string().nullish(),
      city: z.string().nullish(),
      department: z.string().nullish(),
      signal: z.enum(["market_gap_band", "points_to_verify", "pepite"]),
      reason: z.string(),
      count: z.number().int().positive(),
      last_at: z.string().nullish(),
      rule_version: z.string().nullish(),
    }),
  ),
});

export function unavailableSaleFeedbackBySale(): SaleFeedbackBySale {
  return { generatedAt: null, windowDays: 90, rows: [], measured: false };
}

/** Lit la réponse JSON de `admin_sale_signal_feedback_by_sale`. */
export function parseSaleFeedbackBySale(raw: unknown): SaleFeedbackBySale {
  const parsed = bySaleSchema.parse(raw);
  return {
    generatedAt: parsed.generated_at ?? null,
    windowDays: parsed.window_days ?? 90,
    measured: true,
    rows: parsed.rows.map((row) => ({
      saleId: row.sale_id,
      title: row.title ?? null,
      city: row.city ?? null,
      department: row.department ?? null,
      signal: row.signal,
      reason: row.reason,
      count: row.count,
      lastAt: row.last_at ?? null,
      ruleVersion: row.rule_version ?? null,
    })),
  };
}

/**
 * Retours « Pas pertinent » par vente, signal et motif (`admin_sale_signal_feedback_by_sale`, migration
 * 20261108180100) : de quoi corriger la fiche en cause. Aucun compte dans la réponse. Même protection que le
 * reste : jeton vérifié, rôle administrateur, client de service.
 */
export async function getAdminSaleFeedbackBySale(
  authToken: string,
  now = new Date(),
): Promise<SaleFeedbackBySale> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");

  const { data, error } = await supabaseAdmin.rpc("admin_sale_signal_feedback_by_sale", {
    p_now: now.toISOString(),
    p_limit: 100,
  });
  if (error) {
    if (isMissingFunction(error)) return unavailableSaleFeedbackBySale();
    throw error;
  }
  return parseSaleFeedbackBySale(data);
}
