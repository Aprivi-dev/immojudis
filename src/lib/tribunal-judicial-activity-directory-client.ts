import {
  tribunalJudicialActivityDirectoryResponseSchema,
  type TribunalJudicialActivityDirectoryResponse,
} from "@/lib/tribunal-judicial-activity-directory";
import type { TribunalJudicialActivityHistoryMonths } from "@/lib/tribunal-judicial-activity";
import { authHeaders } from "@/lib/client-api-core";

export async function fetchTribunalJudicialActivityDirectory(
  historyMonths: TribunalJudicialActivityHistoryMonths = 36,
): Promise<TribunalJudicialActivityDirectoryResponse> {
  const params = new URLSearchParams({ historyMonths: String(historyMonths) });
  const response = await fetch(
    `/api/v1/tribunals/judicial-activity/directory?${params.toString()}`,
    { headers: await authHeaders(), cache: "no-store" },
  );
  const payload = (await response.json().catch(() => null)) as
    | (unknown & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }
  return tribunalJudicialActivityDirectoryResponseSchema.parse(payload);
}
