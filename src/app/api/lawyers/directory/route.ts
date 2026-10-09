import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { lawyerDirectoryQuerySchema, listLawyerDirectory } from "@/lib/lawyer-directory";
import { enforceIpRateLimit } from "@/lib/rate-limit";
import { PUBLIC_DIRECTORY_CACHE_SECONDS, RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

export async function GET(request: Request) {
  try {
    await enforceIpRateLimit({
      request,
      bucketKey: "lawyers.directory",
      ...RATE_LIMIT_POLICIES.publicIp,
    });
    const url = new URL(request.url);
    const query = lawyerDirectoryQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
      bar: url.searchParams.get("bar") ?? undefined,
      city: url.searchParams.get("city") ?? undefined,
      department: url.searchParams.get("department") ?? undefined,
      page: url.searchParams.get("page") ?? undefined,
    });
    const directory = await listLawyerDirectory(query);
    return NextResponse.json(directory, {
      headers: {
        // The directory is identical for every visitor, so the edge may keep it for an hour.
        "cache-control": `public, s-maxage=${PUBLIC_DIRECTORY_CACHE_SECONDS}, stale-while-revalidate=300`,
      },
    });
  } catch (error) {
    return apiRouteError(error, request, "lawyers.directory", {
      fallbackMessage: "Annuaire indisponible",
      extra: {
        lawyers: [],
        sectorLabel: null,
        barAssociation: null,
        isDemo: false,
        officialSource: null,
      },
    });
  }
}
