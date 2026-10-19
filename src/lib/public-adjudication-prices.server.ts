import "server-only";
import { cache } from "react";
import { getAdjudicationPriceStatisticsDirectory } from "@/lib/adjudication-price-statistics-repository";
import {
  buildPublicAdjudicationPrices,
  isPublicAdjudicationPricesEnabled,
  type PublicAdjudicationPrices,
} from "@/lib/public-adjudication-prices";

type PublicAdjudicationPricesResult =
  | { status: "ok"; data: PublicAdjudicationPrices }
  /** Interrupteur fermé : la page répond 404 et n'est pas listée. */
  | { status: "disabled" }
  /** Aucun build revu, échantillon sous le seuil ou base injoignable : la page ne montre aucun chiffre. */
  | { status: "unavailable" };

/**
 * Agrégats nationaux de la page publique. Fermé, il ne lit rien. Mémorisé par requête : la page et
 * `generateMetadata` partagent une seule lecture. Une erreur n'est jamais rendue comme « 0 vente »
 * (`unavailable`), et son détail reste dans les journaux serveur, pas dans la réponse.
 */
export const loadPublicAdjudicationPrices = cache(
  async (): Promise<PublicAdjudicationPricesResult> => {
    if (!isPublicAdjudicationPricesEnabled()) return { status: "disabled" };
    try {
      const data = buildPublicAdjudicationPrices(await getAdjudicationPriceStatisticsDirectory());
      return data ? { status: "ok", data } : { status: "unavailable" };
    } catch (error) {
      console.warn("[prix-encheres] Statistiques de prix indisponibles:", error);
      return { status: "unavailable" };
    }
  },
);
