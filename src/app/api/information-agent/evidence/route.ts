import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { createApprovedEvidenceSignedUrl } from "@/lib/information-agent-evidence-url";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/**
 * Serves a published attachment of the (private) approved-evidence bucket by redirecting to a
 * signed URL valid for 10 minutes, generated per request. The path must belong to an accepted fact
 * of a currently visible sale.
 */
export async function GET(request: Request) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "information-agent.evidence",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const path = new URL(request.url).searchParams.get("path");
    const signedUrl = await createApprovedEvidenceSignedUrl(path);
    if (!signedUrl) {
      return NextResponse.json(
        { ok: false, error: "Pièce introuvable." },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.redirect(signedUrl, {
      status: 307,
      headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
    });
  } catch (error) {
    return apiRouteError(error, request, "information-agent.evidence", {
      fallbackMessage: "Pièce indisponible.",
    });
  }
}
