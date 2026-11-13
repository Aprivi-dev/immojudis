import {
  tribunalJudicialActivityDirectoryResponseSchema,
  type TribunalJudicialActivityDirectoryResponse,
} from "@/lib/tribunal-judicial-activity-directory";
import type { TribunalJudicialActivityHistoryMonths } from "@/lib/tribunal-judicial-activity";
import { apiRequest } from "@/lib/client-api-core";

export async function fetchTribunalJudicialActivityDirectory(
  historyMonths: TribunalJudicialActivityHistoryMonths = 36,
): Promise<TribunalJudicialActivityDirectoryResponse> {
  const params = new URLSearchParams({ historyMonths: String(historyMonths) });
  return tribunalJudicialActivityDirectoryResponseSchema.parse(
    await apiRequest<unknown>(`/api/v1/tribunals/judicial-activity/directory?${params.toString()}`),
  );
}
