import { z } from "zod";
import { RateLimitError } from "@/lib/api-errors";
import { rateLimitResponse } from "@/lib/api-observability";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { matchClimaScoreCommune } from "@/lib/climascore";

const schema = z.object({
  city: z.string().trim().min(2).max(100),
  postalCode: z.string().regex(/^\d{5}$/),
});

export async function GET(request: Request) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "climascore.commune",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
  } catch (error) {
    if (error instanceof RateLimitError) return rateLimitResponse(error, { commune: null });
    throw error;
  }
  const parsed = schema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ commune: null }, { status: 400 });
  const url = new URL("https://geo.api.gouv.fr/communes");
  url.searchParams.set("codePostal", parsed.data.postalCode);
  url.searchParams.set("fields", "code,nom");
  try {
    const response = await fetch(url, {
      next: { revalidate: 604800 },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Commune lookup unavailable");
    const commune = matchClimaScoreCommune(await response.json(), parsed.data.city);
    return Response.json(
      { commune },
      { headers: { "Cache-Control": "public, max-age=86400, s-maxage=604800" } },
    );
  } catch {
    return Response.json(
      { commune: null },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
