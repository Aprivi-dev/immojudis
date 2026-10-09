import { NextResponse } from "next/server";
import { apiRouteError } from "@/lib/api-observability";
import { lawyerDirectoryQuerySchema, listLawyerDirectory } from "@/lib/lawyer-directory";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = lawyerDirectoryQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
      bar: url.searchParams.get("bar") ?? undefined,
      city: url.searchParams.get("city") ?? undefined,
      department: url.searchParams.get("department") ?? undefined,
    });
    return NextResponse.json(await listLawyerDirectory(query));
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
