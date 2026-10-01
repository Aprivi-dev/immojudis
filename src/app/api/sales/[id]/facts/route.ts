import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { DETAIL_VIEW } from "@/lib/queries";
import { readSaleFactClaims } from "@/lib/auction-fact-claims";
import { getFactReliabilitiesFromClaims } from "@/lib/fact-reliability";
import { assertSalePublicationVisible } from "@/lib/sale-publication-guard";
import type { AuctionSale } from "@/lib/types";

const saleIdSchema = z.string().uuid();

// This is the minimum legacy payload needed to preserve the existing
// reliability calculation when no claim rows exist yet.
const LEGACY_RELIABILITY_COLUMNS = [
  "id",
  "title",
  "property_type",
  "source_checks",
  "source_conflicts",
  "quality_flags",
  "sale_date",
  "starting_price_eur",
  "occupancy_status",
  "app_surface_m2",
  "habitable_surface_m2",
  "carrez_surface_m2",
  "land_surface_m2",
  "app_surface_kind",
  "surface_scope",
  "surface_source",
  "surface_confidence",
  "surface_evidence",
  "rooms_count",
  "bedrooms_count",
].join(",");

type SaleFactsResponse = {
  facts: ReturnType<typeof getFactReliabilitiesFromClaims>;
  source: "claims" | "legacy";
};

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<SaleFactsResponse | { error: string }>> {
  const parsedId = saleIdSchema.safeParse((await context.params).id);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Identifiant de vente invalide." }, { status: 400 });
  }

  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const { data: sale, error: saleError } = await auth.supabase
      .from(DETAIL_VIEW)
      .select(LEGACY_RELIABILITY_COLUMNS)
      .eq("id", parsedId.data)
      .maybeSingle();

    if (saleError) throw saleError;
    // The access check uses the user's RLS-bound client. The service-role
    // reader below is only reached after the sale is visible to that user.
    if (!sale) {
      return NextResponse.json({ error: "Vente introuvable." }, { status: 404 });
    }

    // Admin JWTs and service-role reads can bypass the catalogue RLS policy.
    // Keep this user-facing facts endpoint subject to the same status and
    // publication-marker gate as the public catalogue.
    await assertSalePublicationVisible(parsedId.data);

    const claimRead = await readSaleFactClaims(parsedId.data);
    const facts = getFactReliabilitiesFromClaims(sale as unknown as AuctionSale, claimRead.claims);

    return NextResponse.json(
      {
        facts,
        source: claimRead.claims.length ? "claims" : "legacy",
      },
      {
        headers: {
          "cache-control": "private, no-store",
          "referrer-policy": "no-referrer",
        },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fiabilité des données indisponible";
    const status = message.startsWith("Unauthorized")
      ? 401
      : message.startsWith("Forbidden")
        ? 403
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
