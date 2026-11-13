import { NextResponse } from "next/server";
import { NotFoundError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import { createApprovedEvidenceSignedUrl } from "@/lib/information-agent-evidence-url";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

/**
 * Serves a published attachment of the (private) approved-evidence bucket by redirecting to a
 * signed URL valid for 10 minutes, generated per request. The path must belong to an accepted fact
 * of a currently visible sale.
 */
export const GET = apiRoute(
  { scope: "api.information-agent.evidence", fallbackMessage: "Pièce indisponible." },
  async (request) => {
    await enforceIpRateLimit({
      request,
      bucketKey: "information-agent.evidence",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const path = new URL(request.url).searchParams.get("path");
    const signedUrl = await createApprovedEvidenceSignedUrl(path);
    if (!signedUrl) throw new NotFoundError("Pièce introuvable.");
    return NextResponse.redirect(signedUrl, {
      status: 307,
      headers: { "referrer-policy": "no-referrer" },
    });
  },
);
