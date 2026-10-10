import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { getSharedPropertyReport } from "@/lib/property-reports";

type RouteParams = {
  params: Promise<{ token: string }>;
};

export async function GET(request: Request, { params }: RouteParams) {
  try {
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
    return apiRouteError(error, request, "property-reports.share.token", {
      fallbackMessage: "Rapport partagé introuvable",
      fallbackStatus: 404,
    });
  }
}
