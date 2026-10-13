import { describe, expect, it } from "vitest";
import {
  buildOfferOpeningPatch,
  OFFER_OPENING_CONSENT_VERSION,
  offerOpeningNotificationSchema,
} from "@/lib/offer-opening-notification";

const timestamp = "2026-10-20T10:00:00.000Z";

describe("offer opening notification", () => {
  it("records the first request with its timestamp and the wording version", () => {
    expect(buildOfferOpeningPatch({ current: null, enabled: true, timestamp })).toEqual({
      notify_enabled: true,
      consented_at: timestamp,
      revoked_at: null,
      consent_text_version: OFFER_OPENING_CONSENT_VERSION,
      consent_source: "offers_page",
    });
  });

  it("keeps the first consent date when the request is repeated", () => {
    expect(
      buildOfferOpeningPatch({
        current: { notify_enabled: true, consent_text_version: "2026-10-20" },
        enabled: true,
        timestamp,
      }),
    ).toBeNull();
  });

  it("timestamps the withdrawal and keeps the wording that was agreed to", () => {
    expect(
      buildOfferOpeningPatch({
        current: { notify_enabled: true, consent_text_version: "2026-10-01" },
        enabled: false,
        timestamp,
      }),
    ).toEqual({
      notify_enabled: false,
      revoked_at: timestamp,
      consent_text_version: "2026-10-01",
    });
    expect(buildOfferOpeningPatch({ current: null, enabled: false, timestamp })).toBeNull();
  });

  it("treats a new request after a withdrawal as a new consent", () => {
    const patch = buildOfferOpeningPatch({
      current: { notify_enabled: false, consent_text_version: "2026-10-01" },
      enabled: true,
      timestamp,
    });
    expect(patch).toMatchObject({
      notify_enabled: true,
      consented_at: timestamp,
      revoked_at: null,
      consent_text_version: OFFER_OPENING_CONSENT_VERSION,
    });
  });

  it("requires the wording version the user saw to opt in", () => {
    expect(
      offerOpeningNotificationSchema.safeParse({
        enabled: true,
        consentTextVersion: OFFER_OPENING_CONSENT_VERSION,
      }).success,
    ).toBe(true);
    expect(offerOpeningNotificationSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(
      offerOpeningNotificationSchema.safeParse({ enabled: true, consentTextVersion: "ancienne" })
        .success,
    ).toBe(false);
    expect(offerOpeningNotificationSchema.safeParse({ enabled: false }).success).toBe(true);
  });
});
