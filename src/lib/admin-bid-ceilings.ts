import "server-only";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Estimations servies (événement `bid_ceiling_calculated`, nom gardé pour les données déjà écrites), lues
 * pour la page admin « Pilotage » par `admin_pilotage_bid_ceilings` (migration 20261101160000) : sur 7 et
 * 30 jours, les comptes à qui l'estimation de marché d'une fiche a été servie, les ventes concernées et le
 * nombre d'occurrences. L'estimation part à l'ouverture de la fiche, avant tout calcul : ce n'est pas un
 * plafond calculé (voir `ceiling_viewed`, `product-events.ts`). Cet indicateur remplace « 3 déblocages »
 * pendant l'offre de lancement, où aucun déblocage n'est consommé (tous les comptes ont l'accès Analyse) :
 * il mesure l'usage de la fonction payante, offre ou non. Nombres exacts, aucun nom, aucune vente nommée.
 *
 * Même protection que le reste du pilotage : jeton de session vérifié, rôle administrateur, lecture avec
 * le client de service. Une lecture en échec remonte ; la route de pilotage répond alors
 * `unavailableBidCeilings()`, tout « non mesuré », jamais zéro. La règle « moins de 5 » est une règle d'affichage de la page.
 */
type BidCeilingCount = number | null;

type BidCeilingWindow = {
  days: 7 | 30;
  /** Comptes distincts à qui une estimation a été servie. */
  accounts: BidCeilingCount;
  /** Ventes distinctes concernées. */
  sales: BidCeilingCount;
  /** Un compte compte une fois par vente et par jour. */
  occurrences: BidCeilingCount;
};

export type BidCeilingSummary = {
  generatedAt: string | null;
  windows: BidCeilingWindow[];
};

const count = z.number().int().nonnegative().nullish();
const summarySchema = z.object({
  generated_at: z.string().nullish(),
  windows: z.array(
    z.object({ days: z.number().int(), accounts: count, sales: count, occurrences: count }),
  ),
});

const WINDOW_DAYS = [7, 30] as const;

/** Réponse quand rien n'a pu être mesuré : tout vaut « non mesuré », jamais zéro. */
export function unavailableBidCeilings(): BidCeilingSummary {
  return {
    generatedAt: null,
    windows: WINDOW_DAYS.map((days) => ({
      days,
      accounts: null,
      sales: null,
      occurrences: null,
    })),
  };
}

/** Lit la réponse JSON de `admin_pilotage_bid_ceilings`. Une fenêtre absente vaut « non mesuré ». */
export function parseBidCeilings(raw: unknown): BidCeilingSummary {
  const summary = summarySchema.parse(raw);
  return {
    generatedAt: summary.generated_at ?? null,
    windows: WINDOW_DAYS.map((days) => {
      const entry = summary.windows.find((window) => window.days === days);
      return {
        days,
        accounts: entry?.accounts ?? null,
        sales: entry?.sales ?? null,
        occurrences: entry?.occurrences ?? null,
      };
    }),
  };
}

/** Comme `getAdminPilotage` : jeton et rôle administrateur vérifiés, puis lecture avec le client de service. */
export async function getAdminBidCeilings(
  authToken: string,
  now = new Date(),
): Promise<BidCeilingSummary> {
  await assertAdminAuth(authToken);

  const { data, error } = await supabaseAdmin.rpc("admin_pilotage_bid_ceilings", {
    p_now: now.toISOString(),
  });
  if (error) throw error;
  return parseBidCeilings(data);
}
