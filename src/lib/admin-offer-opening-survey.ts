import "server-only";
import { z } from "zod";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Réponses du questionnaire de la liste d'attente (« Me prévenir de l'ouverture »), lues pour la page admin
 * « Pilotage » par `admin_offer_opening_survey_summary` (migration 20261108180200) : répartition par profil,
 * médiane des deux repères de prix (nulle sous 10 réponses), acceptants d'un entretien. Aucune ligne
 * individuelle. Les repères de prix sont déclaratifs et viennent d'une liste d'attente qui s'est choisie
 * elle-même : ils ne mesurent pas une intention d'achat.
 *
 * Même protection que le reste du pilotage : jeton vérifié, rôle administrateur, client de service. Une mesure
 * impossible (migration pas encore appliquée, panne) vaut `null` et s'affiche « non mesuré », jamais zéro. La
 * règle « moins de 5 » est une règle d'affichage de la page.
 */
export type SurveyCount = number | null;

export type OfferOpeningSurveySummary = {
  generatedAt: string | null;
  /** Réponses données (au moins une question répondue ou l'entretien accepté). */
  answered: SurveyCount;
  profiles: {
    particulier: SurveyCount;
    marchand_de_biens: SurveyCount;
    avocat: SurveyCount;
    autre: SurveyCount;
    unanswered: SurveyCount;
  };
  /** Prix mensuel jugé trop cher : nombre de réponses, et médiane (nulle sous le seuil de la base). */
  priceTooExpensive: { answers: SurveyCount; medianEur: number | null };
  /** Prix mensuel jugé bon marché. */
  priceCheap: { answers: SurveyCount; medianEur: number | null };
  interviewAccepted: SurveyCount;
  /** Seuil de réponses sous lequel la base ne rend pas de médiane. */
  minMedianAnswers: number;
};

const count = z.number().int().nonnegative().nullish();
const priceSchema = z.object({ answers: count, median_eur: z.number().nonnegative().nullish() });
const summarySchema = z.object({
  generated_at: z.string().nullish(),
  min_median_answers: z.number().int().positive().nullish(),
  answered: count,
  profiles: z
    .object({
      particulier: count,
      marchand_de_biens: count,
      avocat: count,
      autre: count,
      unanswered: count,
    })
    .nullish(),
  price_too_expensive: priceSchema.nullish(),
  price_cheap: priceSchema.nullish(),
  interview_accepted: count,
});

const orNull = (value: number | null | undefined): SurveyCount => value ?? null;

/** Réponse quand rien n'a pu être mesuré : tout vaut « non mesuré », jamais zéro. */
export function unavailableOfferOpeningSurvey(): OfferOpeningSurveySummary {
  return {
    generatedAt: null,
    answered: null,
    profiles: {
      particulier: null,
      marchand_de_biens: null,
      avocat: null,
      autre: null,
      unanswered: null,
    },
    priceTooExpensive: { answers: null, medianEur: null },
    priceCheap: { answers: null, medianEur: null },
    interviewAccepted: null,
    minMedianAnswers: 10,
  };
}

/** Lit la réponse JSON de `admin_offer_opening_survey_summary`. */
export function parseOfferOpeningSurvey(raw: unknown): OfferOpeningSurveySummary {
  const summary = summarySchema.parse(raw);
  const profiles = summary.profiles;
  return {
    generatedAt: summary.generated_at ?? null,
    answered: orNull(summary.answered),
    profiles: {
      particulier: orNull(profiles?.particulier),
      marchand_de_biens: orNull(profiles?.marchand_de_biens),
      avocat: orNull(profiles?.avocat),
      autre: orNull(profiles?.autre),
      unanswered: orNull(profiles?.unanswered),
    },
    priceTooExpensive: {
      answers: orNull(summary.price_too_expensive?.answers),
      medianEur: summary.price_too_expensive?.median_eur ?? null,
    },
    priceCheap: {
      answers: orNull(summary.price_cheap?.answers),
      medianEur: summary.price_cheap?.median_eur ?? null,
    },
    interviewAccepted: orNull(summary.interview_accepted),
    minMedianAnswers: summary.min_median_answers ?? 10,
  };
}

/** Fonction de base absente (migration pas encore appliquée) : rien n'est mesuré. */
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/** Comme `getAdminBidCeilings` : jeton et rôle administrateur vérifiés, puis lecture avec le client de service. */
export async function getAdminOfferOpeningSurvey(
  authToken: string,
  now = new Date(),
): Promise<OfferOpeningSurveySummary> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");

  const { data, error } = await supabaseAdmin.rpc("admin_offer_opening_survey_summary", {
    p_now: now.toISOString(),
  });
  if (error) {
    if (isMissingFunction(error)) return unavailableOfferOpeningSurvey();
    throw error;
  }
  return parseOfferOpeningSurvey(data);
}
