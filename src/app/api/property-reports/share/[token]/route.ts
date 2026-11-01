import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { getSharedPropertyReport } from "@/lib/property-reports";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

type RouteParams = {
  params: Promise<{ token: string }>;
};

export async function GET(request: Request, { params }: RouteParams) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "property-reports.share",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const { token } = await params;
    const report = await getSharedPropertyReport({ token });

    return NextResponse.json(
      { report },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    // Un lien inconnu ou expiré reste un 404 (message métier) ; une panne de lecture est un 500.
    return apiRouteError(error, request, "property-reports.share.token", {
      fallbackMessage: "Rapport partagé indisponible.",
      fallbackStatus: 500,
    });
  }
}
