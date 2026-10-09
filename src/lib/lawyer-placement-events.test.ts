import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ featured: vi.fn(), consume: vi.fn(), insert: vi.fn() }));
vi.mock("@/lib/featured-lawyers", () => ({ getFeaturedReferencedLawyerForSale: mocks.featured }));
vi.mock("@/lib/rate-limit", () => ({ tryConsumeUserRateLimit: mocks.consume }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => ({ insert: mocks.insert }) },
}));

import {
  buildLawyerPlacementEventInsert,
  placementEventDedupeKey,
  recordLawyerPlacementEvent,
} from "@/lib/lawyer-placement-events";
import type { FeaturedReferencedLawyer } from "@/lib/featured-lawyers";
import type { LawyerPlacementEventPayload } from "@/lib/lawyer-placement-events";

const SALE_ID = "22222222-2222-4222-8222-222222222222";
const LAWYER_ID = "33333333-3333-4333-8333-333333333333";

describe("lawyer placement events", () => {
  it("builds anonymous paid-placement analytics only for the featured referenced lawyer", () => {
    const payload = buildLawyerPlacementEventInsert({
      input: eventPayload({
        pagePath: "/ventes/appartement-test?from=alert",
      }),
      featuredLawyer: featuredLawyer(),
    });

    expect(payload).toMatchObject({
      lawyer_id: LAWYER_ID,
      sale_id: SALE_ID,
      event_type: "impression",
      placement_slot: "sale_detail_sticky_lawyer",
      matching_basis: "department",
      sector_label: "33",
      metadata: {
        source: "featured_lawyer_placement",
        viewport: "desktop",
        page_path: "/ventes/appartement-test?from=alert",
      },
    });
    expect(JSON.stringify(payload)).not.toContain("lawyer_name");
    expect(JSON.stringify(payload)).not.toContain("lawyer_contact");
    expect(JSON.stringify(payload)).not.toContain("source@example.test");
  });

  it("does not record clicks for a lawyer that is not the featured placement", () => {
    const payload = buildLawyerPlacementEventInsert({
      input: eventPayload({
        lawyerId: "44444444-4444-4444-8444-444444444444",
        eventType: "cta_click",
      }),
      featuredLawyer: featuredLawyer(),
    });

    expect(payload).toBeNull();
  });
});

function eventPayload(
  overrides: Partial<LawyerPlacementEventPayload> = {},
): LawyerPlacementEventPayload {
  return {
    saleId: SALE_ID,
    lawyerId: LAWYER_ID,
    eventType: "impression",
    placementSlot: "sale_detail_sticky_lawyer",
    viewport: "desktop",
    ...overrides,
  };
}

function featuredLawyer(
  overrides: Partial<FeaturedReferencedLawyer> = {},
): FeaturedReferencedLawyer {
  return {
    id: LAWYER_ID,
    displayName: "Me Reference",
    firmName: "Cabinet ImmoJudis",
    barAssociation: "Bordeaux",
    city: "Bordeaux",
    department: "33",
    profileSummary: "Adjudication immobiliere.",
    practiceTags: ["adjudication"],
    matchingBasis: "department",
    sectorLabel: "33",
    ...overrides,
  };
}

describe("lawyer placement event deduplication", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.featured.mockResolvedValue({ lawyer: featuredLawyer() });
    mocks.insert.mockResolvedValue({ error: null });
  });

  it("records the first event of the day for a user, placement and event type", async () => {
    mocks.consume.mockResolvedValue(true);

    const result = await recordLawyerPlacementEvent({ input: eventPayload(), userId: "user-1" });

    expect(result).toEqual({ ok: true, recorded: true, reason: "recorded" });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledWith({
      userId: "user-1",
      bucketKey: placementEventDedupeKey(eventPayload()),
      limit: 1,
      windowSeconds: 86_400,
    });
  });

  it("drops a repeat of the same event by the same user on the same day", async () => {
    mocks.consume.mockResolvedValue(false);

    const result = await recordLawyerPlacementEvent({ input: eventPayload(), userId: "user-1" });

    expect(result).toEqual({ ok: true, recorded: false, reason: "duplicate" });
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("keys the daily counter by event type, lawyer, sale and slot", () => {
    const impression = placementEventDedupeKey(eventPayload());
    expect(placementEventDedupeKey(eventPayload({ eventType: "cta_click" }))).not.toBe(impression);
    expect(placementEventDedupeKey(eventPayload({ placementSlot: "other_slot" }))).not.toBe(
      impression,
    );
    expect(impression).toContain(SALE_ID);
    expect(impression).toContain(LAWYER_ID);
  });
});
