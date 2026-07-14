import { NextResponse } from "next/server";
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
    const message = error instanceof Error ? error.message : "Annuaire indisponible";
    const status = message.includes("introuvable") ? 404 : 400;
    return NextResponse.json(
      { lawyers: [], sectorLabel: null, barAssociation: null, isDemo: false, error: message },
      { status },
    );
  }
}
