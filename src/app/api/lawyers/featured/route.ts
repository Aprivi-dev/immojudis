import { NextResponse } from "next/server";
import {
  featuredLawyerQuerySchema,
  getFeaturedReferencedLawyerForSale,
} from "@/lib/featured-lawyers";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = featuredLawyerQuerySchema.parse({
      saleId: url.searchParams.get("saleId") ?? undefined,
    });

    return NextResponse.json(await getFeaturedReferencedLawyerForSale(query));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Avocat référencé indisponible sur ce secteur";
    const status = message.includes("introuvable") ? 404 : 400;
    return NextResponse.json({ lawyer: null, error: message }, { status });
  }
}
