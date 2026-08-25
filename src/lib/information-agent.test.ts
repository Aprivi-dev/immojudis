import { describe, expect, it, vi } from "vitest";
import {
  buildInformationRequestDraft,
  detectInformationGaps,
  informationAgentActionSchema,
  informationAgentCreateSchema,
} from "@/lib/information-agent";
import type { AuctionSale } from "@/lib/types";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
}));

vi.mock("@/lib/property-reports", () => ({
  resolvePlanEntitlements: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceUserRateLimit: vi.fn(),
}));

describe("supervised information agent", () => {
  it("detects the material gaps of an incomplete auction listing", () => {
    const gaps = detectInformationGaps(incompleteSale());

    expect(gaps.map((gap) => gap.key)).toEqual([
      "documents",
      "photos",
      "visit",
      "occupancy",
      "surface",
      "diagnostics",
      "composition",
      "sale_terms",
    ]);
  });

  it("builds a transparent, bounded draft without disclosing bidding capacity", () => {
    const draft = buildInformationRequestDraft({
      sale: incompleteSale(),
      recipientName: "Maître Dupont",
      questionKeys: ["documents", "photos", "visit"],
    });

    expect(draft.subject).toContain("audience du 14 septembre 2026");
    expect(draft.bodyText).toContain("service indépendant d’analyse");
    expect(draft.bodyText).toContain("contrôlée avant toute intégration");
    expect(draft.bodyText).toContain("cahier des conditions de vente");
    expect(draft.bodyText).not.toMatch(/plafond d.enchère|budget de l.utilisateur/i);
  });

  it("requires an explicit approval and email-sharing choice for every send", () => {
    const base = {
      action: "approve_and_send",
      missionId: "22222222-2222-4222-8222-222222222222",
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Dupont",
      subject: "Demande de pièces",
      bodyText: "Bonjour, pourriez-vous transmettre les pièces du dossier ?",
    };

    expect(
      informationAgentActionSchema.safeParse({
        ...base,
        approvalConfirmed: true,
        shareRequesterEmail: true,
      }).success,
    ).toBe(true);
    expect(
      informationAgentActionSchema.safeParse({
        ...base,
        approvalConfirmed: false,
        shareRequesterEmail: true,
      }).success,
    ).toBe(false);
    expect(informationAgentCreateSchema.safeParse({ saleId: base.missionId }).success).toBe(true);
  });
});

function incompleteSale(): AuctionSale {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Appartement T3 à Bordeaux",
    property_type: "apartment",
    postal_code: "33000",
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    sale_date: "2026-09-14T09:00:00.000Z",
    starting_price_eur: 85_000,
    documents: null,
    documents_rich: null,
    media: null,
    visit_dates: null,
    occupancy_status: null,
    app_surface_m2: null,
    habitable_surface_m2: null,
    carrez_surface_m2: null,
    land_surface_m2: null,
    app_surface_kind: null,
    surface_scope: null,
    rooms_count: null,
    sale_procedure: null,
  } as AuctionSale;
}
