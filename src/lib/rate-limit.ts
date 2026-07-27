import { supabaseAdmin } from "@/integrations/supabase/client.server";

type RateLimitRpcClient = {
  rpc(
    name: "consume_api_rate_limit",
    args: {
      p_bucket_key: string;
      p_limit: number;
      p_user_id: string;
      p_window_seconds: number;
    },
  ): Promise<{ data: number | null; error: { message?: string } | null }>;
};

export async function enforceUserRateLimit({
  userId,
  bucketKey,
  limit,
  windowSeconds,
}: {
  userId: string;
  bucketKey: string;
  limit: number;
  windowSeconds: number;
}): Promise<number> {
  const client = supabaseAdmin as unknown as RateLimitRpcClient;
  const { data, error } = await client.rpc("consume_api_rate_limit", {
    p_bucket_key: bucketKey,
    p_limit: limit,
    p_user_id: userId,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    if (error.message?.includes("Rate limit exceeded")) {
      throw new Error("Trop de demandes. Réessayez dans une minute.");
    }
    throw new Error(error.message || "Contrôle de débit indisponible.");
  }

  return Number(data ?? 0);
}
