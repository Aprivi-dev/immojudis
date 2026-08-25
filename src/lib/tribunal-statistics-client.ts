import { supabase } from "@/integrations/supabase/client";
import {
  tribunalStatisticsResponseSchema,
  type TribunalStatisticsResponse,
  type TribunalStatisticsWindowMonths,
} from "@/lib/tribunal-statistics";

export async function fetchTribunalStatistics(args: {
  windowMonths: TribunalStatisticsWindowMonths;
  courtCode?: string;
}): Promise<TribunalStatisticsResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Connexion requise.");

  const params = new URLSearchParams({ windowMonths: String(args.windowMonths) });
  if (args.courtCode?.trim()) params.set("courtCode", args.courtCode.trim());
  const response = await fetch(`/api/v1/tribunals/statistics?${params.toString()}`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as
    | (unknown & { error?: string })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Erreur HTTP ${response.status}`);
  }

  return tribunalStatisticsResponseSchema.parse(payload);
}
