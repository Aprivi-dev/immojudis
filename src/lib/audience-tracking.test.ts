import { describe, expect, it } from "vitest";
import { buildAudienceTrackingItem, buildAudienceTrackingResponse } from "@/lib/audience-tracking";
import {
  DEFAULT_DOCUMENT_REVIEW,
  DEFAULT_SALE_CHECKLIST,
  DEFAULT_WORKSPACE_NOTES,
} from "@/lib/sale-workspace-shared";
import type { SaleWorkspace } from "@/lib/sale-workspaces";
import type { AuctionSale } from "@/lib/types";

const NOW = new Date("2026-07-06T08:00:00.000Z");

describe("audience tracking", () => {
  it("prioritizes overdue actions and open priority document questions", () => {
    const workspace = workspaceFixture({
      checklist: {
        [DEFAULT_SALE_CHECKLIST[0]]: true,
        [DEFAULT_SALE_CHECKLIST[1]]: true,
      },
      document_reviews: {
        "conditions:main": {
          ...DEFAULT_DOCUMENT_REVIEW,
          status: "question",
          question: "La clause d'occupation est-elle confirmée ?",
          priority: true,
        },
      },
      next_action: "Appeler le conseil",
      next_action_due_at: "2026-07-05T17:00:00.000Z",
    });
    const sale = saleFixture({
      sale_date: "2026-07-10T10:00:00.000Z",
      documents_rich: [
        {
          url: "https://example.test/cahier.pdf",
          label: "Cahier des conditions de vente",
          type: "cahier",
          extraction_status: "completed",
        },
        {
          url: "https://example.test/pv.pdf",
          label: "PV descriptif",
          type: "pv",
          extraction_status: "completed",
        },
      ],
    });

    const item = buildAudienceTrackingItem({ workspace, sale, now: NOW });

    expect(item.actionStatus).toBe("overdue");
    expect(item.readiness).toBe("urgent");
    expect(item.checklist).toMatchObject({ total: 6, done: 2, open: 4, progressPct: 33 });
    expect(item.documents).toMatchObject({
      expected: 2,
      tracked: 1,
      total: 2,
      reviewed: 0,
      open: 2,
      questions: 1,
      priorityOpen: 1,
    });
  });

  it("marks a bidding workspace ready when checklist and documents are reviewed", () => {
    const checklist = Object.fromEntries(DEFAULT_SALE_CHECKLIST.map((label) => [label, true]));
    const workspace = workspaceFixture({
      tracking_status: "bidding",
      checklist,
      document_reviews: {
        "diagnostic:main": {
          ...DEFAULT_DOCUMENT_REVIEW,
          status: "reviewed",
          reviewedAt: "2026-07-06T07:00:00.000Z",
        },
      },
      next_action: "Dernier contrôle audience",
      next_action_due_at: "2026-07-20T09:00:00.000Z",
    });
    const sale = saleFixture({
      sale_date: "2026-08-20T09:00:00.000Z",
      documents_rich: [
        {
          url: "https://example.test/diagnostic.pdf",
          label: "Diagnostics techniques",
          type: "diagnostics",
          extraction_status: "completed",
        },
      ],
    });

    const response = buildAudienceTrackingResponse({
      workspaces: [workspace],
      sales: [sale],
      now: NOW,
    });

    expect(response.summary.readyToBid).toBe(1);
    expect(response.summary.checklistProgressPct).toBe(100);
    expect(response.summary.reviewedDocuments).toBe(1);
    expect(response.items[0]).toMatchObject({
      readiness: "ready",
      actionStatus: "scheduled",
    });
    expect(response.sections.ready).toHaveLength(1);
  });

  it("keeps missing audience dates explicit in the dashboard summary", () => {
    const response = buildAudienceTrackingResponse({
      workspaces: [workspaceFixture()],
      sales: [saleFixture({ sale_date: null })],
      now: NOW,
    });

    expect(response.summary.missingAudienceDates).toBe(1);
    expect(response.items[0]).toMatchObject({
      audienceUrgency: "unknown",
      readiness: "missing_date",
    });
  });
});

function workspaceFixture(overrides: Partial<SaleWorkspace> = {}): SaleWorkspace {
  return {
    id: "7d335032-e935-4550-9347-ed22b0f63449",
    user_id: "31c5a4b3-f5bf-45d1-a3db-09ba9b1c08e2",
    sale_id: "018c5dc8-cb2e-49d1-9ac8-1b69e6400367",
    tracking_status: "reviewing",
    user_max_bid_eur: null,
    target_yield_pct: null,
    private_notes: DEFAULT_WORKSPACE_NOTES,
    checklist: {},
    alert_preferences: {},
    document_reviews: {},
    next_action: null,
    next_action_due_at: null,
    last_synced_at: "2026-07-06T08:00:00.000Z",
    created_at: "2026-07-06T08:00:00.000Z",
    updated_at: "2026-07-06T08:00:00.000Z",
    ...overrides,
  };
}

function saleFixture(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "018c5dc8-cb2e-49d1-9ac8-1b69e6400367",
    title: "Appartement suivi",
    city: "Lyon",
    department: "69",
    tribunal: "TJ Lyon",
    tribunal_name: "Tribunal judiciaire de Lyon",
    starting_price_eur: 120_000,
    sale_date: "2026-07-30T09:00:00.000Z",
    documents_rich: null,
    documents: null,
    ...overrides,
  } as AuctionSale;
}
