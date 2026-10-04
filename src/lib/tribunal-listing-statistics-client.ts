import {
  tribunalListingStatisticsResponseSchema,
  TribunalCourtUnresolvedError,
  type TribunalListingStatisticsHistoryMonths,
  type TribunalListingStatisticsResponse,
} from "@/lib/tribunal-listing-statistics";
import { authHeaders } from "@/lib/client-api-core";

type TribunalListingStatisticsClientQuery =
  | { courtCode: string; saleId?: never }
  | { courtCode?: never; saleId: string };

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

  const response = await fetch(`/api/v1/tribunals/listing-statistics?${params.toString()}`, {
    headers: await authHeaders(),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | (unknown & { error?: string; code?: string })
    | null;
  if (!response.ok) {
    if (response.status === 422 && payload?.code === "COURT_UNRESOLVED") {
      throw new TribunalCourtUnresolvedError();
    }
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }
  return tribunalListingStatisticsResponseSchema.parse(payload);
}
