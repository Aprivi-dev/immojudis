import { describe, expect, it, vi } from "vitest";
import {
  assertInformationAgentOutboundEnabled,
  buildInformationRequestDraft,
  createAdminInformationAgentDraft,
  detectInformationGaps,
  informationAgentAdminActionSchema,
  informationAgentCreateSchema,
  runAdminInformationAgentAction,
  selectDefaultInformationAgentQuestionKeys,
} from "@/lib/information-agent";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { AuctionSale } from "@/lib/types";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), rpc: vi.fn() },
}));

describe("supervised information agent", () => {
  it("keeps outbound email disabled until it is explicitly enabled", () => {
    expect(() => assertInformationAgentOutboundEnabled({ NODE_ENV: "test" })).toThrow("désactivé");
    expect(() =>
      assertInformationAgentOutboundEnabled({
        NODE_ENV: "test",
        INFORMATION_AGENT_OUTBOUND_ENABLED: "false",
      }),
    ).toThrow("désactivé");
    expect(() =>
      assertInformationAgentOutboundEnabled({
        NODE_ENV: "test",
        INFORMATION_AGENT_OUTBOUND_ENABLED: "true",
      }),
    ).not.toThrow();
  });

  it("blocks the admin send action before any mutation or network call", async () => {
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn().mockResolvedValue({
        data: { id: "22222222-2222-4222-8222-222222222222", status: "draft" },
        error: null,
      }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    vi.mocked(supabaseAdmin.from).mockReturnValue(query as never);
    const fetchImpl = vi.fn();
    vi.stubEnv("INFORMATION_AGENT_OUTBOUND_ENABLED", "false");
    try {
      await expect(
        runAdminInformationAgentAction({
          auth: { isAdmin: true, userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as never,
          input: {
            action: "approve_and_send",
            missionId: "22222222-2222-4222-8222-222222222222",
            approvalConfirmed: true,
            recipientEmail: "contact@example.test",
            subject: "Informations complémentaires",
            bodyText: "Bonjour, merci de nous transmettre les informations du dossier.",
          },
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).rejects.toThrow("désactivé");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(supabaseAdmin.from).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      vi.mocked(supabaseAdmin.from).mockReset();
    }
  });
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
    expect(selectDefaultInformationAgentQuestionKeys(gaps)).toEqual([
      "documents",
      "visit",
      "occupancy",
    ]);
  });

  it("builds a transparent, bounded draft without disclosing bidding capacity", () => {
    const draft = buildInformationRequestDraft({
      sale: incompleteSale(),
      recipientName: "Maître Dupont",
      questionKeys: ["documents", "photos", "visit"],
    });

    expect(draft.subject).toBe("Appartement T3 à Bordeaux — précisions sur la vente");
    expect(draft.bodyText).toContain("service indépendant d’information");
    expect(draft.bodyText).toContain("Une réponse partielle nous aidera déjà");
    expect(draft.bodyText).toContain("Audience annoncée : 14 septembre 2026");
    expect(draft.bodyText).toContain("cahier des conditions de vente");
    expect(draft.bodyText).not.toContain("utilisateur intéressé");
    expect(draft.bodyText).not.toMatch(/plafond d.enchère|budget de l.utilisateur/i);
  });

  it("omits an unknown hearing date and uses a neutral greeting", () => {
    const draft = buildInformationRequestDraft({
      sale: { ...incompleteSale(), sale_date: null },
      questionKeys: ["documents"],
    });

    expect(draft.subject).not.toContain("Date à confirmer");
    expect(draft.bodyText).toContain("Madame, Monsieur,");
    expect(draft.bodyText).not.toContain("Audience annoncée");
    expect(draft.bodyText).not.toContain("Date à confirmer");
  });

  it("keeps a long sale title short in the email subject", () => {
    const draft = buildInformationRequestDraft({
      sale: {
        ...incompleteSale(),
        title:
          "Appartement situé dans un immeuble ancien avec dépendances et plusieurs lots à Bordeaux",
      },
      questionKeys: ["documents"],
    });

    expect(draft.subject.length).toBeLessThanOrEqual(100);
    expect(draft.subject).toContain("… — précisions sur la vente");
    expect(draft.bodyText).toContain("plusieurs lots à Bordeaux");
  });

  it("requires explicit admin approval for every send", () => {
    const base = {
      action: "approve_and_send",
      missionId: "22222222-2222-4222-8222-222222222222",
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Dupont",
      subject: "Demande de pièces",
      bodyText: "Bonjour, pourriez-vous transmettre les pièces du dossier ?",
    };

    expect(
      informationAgentAdminActionSchema.safeParse({
        ...base,
        approvalConfirmed: false,
      }).success,
    ).toBe(false);
    expect(informationAgentCreateSchema.safeParse({ saleId: base.missionId }).success).toBe(true);
  });

  it("accepts the admin send approval without a requester-email sharing flag", () => {
    const result = informationAgentAdminActionSchema.safeParse({
      action: "approve_and_send",
      missionId: "22222222-2222-4222-8222-222222222222",
      approvalConfirmed: true,
      recipientEmail: "cabinet@example.test",
      recipientName: "Maître Dupont",
      subject: "Demande de pièces",
      bodyText: "Bonjour, pourriez-vous transmettre les pièces du dossier ?",
    });

    expect(result.success).toBe(true);
  });

  it("rejects the admin draft workflow for non-admin auth", async () => {
    await expect(
      createAdminInformationAgentDraft({
        auth: { isAdmin: false } as never,
        input: { saleId: "11111111-1111-4111-8111-111111111111" },
      }),
    ).rejects.toThrow("Forbidden: accès administrateur requis.");
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
