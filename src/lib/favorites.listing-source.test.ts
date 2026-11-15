import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ plan: vi.fn() }));
vi.mock("@/lib/account-product-events.server", () => ({ recordAccountProductEvent: vi.fn() }));
vi.mock("@/lib/entitlements.server", () => ({ resolvePlanEntitlements: mocks.plan }));
vi.mock("@/lib/usage", () => ({ recordFeatureUsageEvent: vi.fn() }));

import { listFavoriteSales } from "./favorites";
import { EXAMPLE_SALE } from "@/lib/example-sale";

const LISTING_URL = "https://annonce-privee.example/vente/42";
const saleId = "7d335032-e935-4550-9347-ed22b0f63449";
const example = (EXAMPLE_SALE.source_blocks as Record<string, unknown>).sale_procedure as Record<
  string,
  unknown
>;
/** The procedure as a database without 20261123100000 still serves it through the discovery view. */
const rawProcedure = {
  ...example,
  sale_session: { opens_at: "2026-12-01T10:00:00+01:00", source_url: LISTING_URL },
  verification: {
    ...(example.verification as Record<string, unknown>),
    case_sources: [
      {
        kind: "listing",
        label: "Plateforme privée",
        source_name: "plateforme-privee",
        url: LISTING_URL,
      },
      {
        kind: "document",
        label: "Cahier des conditions de vente",
        source_name: "plateforme-privee",
        url: "https://pieces.example/ccv.pdf",
      },
    ],
  },
};

function authReturning(views: string[]) {
  return {
    userId: "user-1",
    supabase: {
      from: (relation: string) => {
        if (relation === "user_favorites") {
          return {
            select: () => ({
              eq: () => ({
                order: async () => ({
                  data: [{ id: "fav-1", sale_id: saleId, created_at: "2026-11-01T10:00:00Z" }],
                  error: null,
                }),
              }),
            }),
          };
        }
        views.push(relation);
        return {
          select: () => ({
            in: async () => ({
              data: [
                {
                  ...EXAMPLE_SALE,
                  id: saleId,
                  sale_procedure: rawProcedure,
                  source_blocks: { sale_procedure: rawProcedure },
                },
              ],
              error: null,
            }),
          }),
        };
      },
    },
  } as never;
}

describe("favorites: the listing source inside sale_procedure", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("is removed again for an account without the Analyse offer, whatever the database serves", async () => {
    mocks.plan.mockResolvedValue({
      plan: "decouverte",
      label: "Découverte",
      limits: { favoriteSales: 10 },
    });
    const views: string[] = [];
    const { favorites } = await listFavoriteSales({ auth: authReturning(views) });

    expect(views).toEqual(["v_auction_sales_discovery"]);
    const text = JSON.stringify(favorites);
    expect(text).not.toContain(LISTING_URL);
    expect(text).not.toContain("plateforme-privee");
    expect(text).toContain("https://pieces.example/ccv.pdf");
    expect(text).toContain("2026-12-01T10:00:00+01:00");
  });

  it("is kept for the offer", async () => {
    mocks.plan.mockResolvedValue({
      plan: "analyse",
      label: "Analyse",
      limits: { favoriteSales: null },
    });
    const views: string[] = [];
    const { favorites } = await listFavoriteSales({ auth: authReturning(views) });

    expect(views).toEqual(["v_auction_sales_app"]);
    expect(JSON.stringify(favorites)).toContain(LISTING_URL);
  });
});
