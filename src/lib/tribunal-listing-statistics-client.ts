import {
  tribunalListingStatisticsResponseSchema,
  type TribunalListingStatisticsHistoryMonths,
  type TribunalListingStatisticsResponse,
} from "@/lib/tribunal-listing-statistics";
import { apiRequest } from "@/lib/client-api-core";

type TribunalListingStatisticsClientQuery =
  | { courtCode: string; saleId?: never }
  | { courtCode?: never; saleId: string };

/**
 * Statistiques du tribunal d'une vente ou d'un code de tribunal. Une vente que le serveur ne rattache
 * pas avec certitude à un tribunal est refusée en 422 avec le code `COURT_UNRESOLVED`, que l'erreur
 * levée porte (`code`).
 */
export async function fetchTribunalListingStatistics(
  args: TribunalListingStatisticsClientQuery & {
    historyMonths?: TribunalListingStatisticsHistoryMonths;
  },
): Promise<TribunalListingStatisticsResponse> {
  const params = new URLSearchParams({
    historyMonths: String(args.historyMonths ?? 3),
  });
  if (typeof args.saleId === "string") params.set("saleId", args.saleId);
  else params.set("courtCode", args.courtCode.trim());

  return tribunalListingStatisticsResponseSchema.parse(
    await apiRequest<unknown>(`/api/v1/tribunals/listing-statistics?${params.toString()}`),
  );
}
