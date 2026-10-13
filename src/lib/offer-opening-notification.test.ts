import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  buildOfferOpeningPatch,
  OFFER_OPENING_CONSENT_TEXT,
  OFFER_OPENING_CONSENT_VERSION,
  offerOpeningNotificationSchema,
  setOfferOpeningNotification,
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

describe("offer opening consent wording", () => {
  it("promises an intention, with no delay and no claim that an email is already wired", () => {
    expect(OFFER_OPENING_CONSENT_TEXT).toBe(
      "En cliquant, vous demandez à recevoir un seul email à l’ouverture de l’offre Analyse. Vous pouvez retirer cette demande à tout moment.",
    );
  });

  it("refuses the previous wording version", () => {
    expect(OFFER_OPENING_CONSENT_VERSION).not.toBe("2026-10-20");
    expect(
      offerOpeningNotificationSchema.safeParse({
        enabled: true,
        consentTextVersion: "2026-10-20",
      }).success,
    ).toBe(false);
  });
});

describe("setOfferOpeningNotification", () => {
  function fakeAdmin(current: Record<string, unknown> | null) {
    const upsert = vi.fn((_row: Record<string, unknown>, _options: unknown) => ({
      select: () => ({
        single: async () => ({
          data: { ...current, ..._row },
          error: null,
        }),
      }),
    }));
    const admin = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: current, error: null }) }),
        }),
        upsert,
      })),
    } as unknown as SupabaseClient<Database>;
    return { admin, upsert };
  }

  it("writes the server clock and the wording version through the service client", async () => {
    const { admin, upsert } = fakeAdmin(null);
    const response = await setOfferOpeningNotification({
      auth: { userId: "user-1" },
      admin,
      input: { enabled: true, consentTextVersion: OFFER_OPENING_CONSENT_VERSION },
      now: new Date(timestamp),
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        consented_at: timestamp,
        consent_text_version: OFFER_OPENING_CONSENT_VERSION,
      }),
      { onConflict: "user_id" },
    );
    expect(response.notification).toEqual({ requested: true, consentedAt: timestamp });
  });

  it("writes nothing when the stored state already matches", async () => {
    const { admin, upsert } = fakeAdmin({
      user_id: "user-1",
      notify_enabled: true,
      consented_at: "2026-10-01T00:00:00.000Z",
      consent_text_version: "x",
    });
    const response = await setOfferOpeningNotification({
      auth: { userId: "user-1" },
      admin,
      input: { enabled: true, consentTextVersion: OFFER_OPENING_CONSENT_VERSION },
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(response.notification.consentedAt).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("offer opening migration", () => {
  const sql = readFileSync(
    "supabase/migrations/20261020100000_offer_opening_notifications.sql",
    "utf8",
  );

  it("gives the authenticated role read access only: consent is written by the server", () => {
    expect(sql).toMatch(
      /grant select on table public\.offer_opening_notifications to authenticated;/,
    );
    expect(sql).not.toMatch(/grant[^;]*\b(insert|update|delete)\b[^;]*to authenticated/i);
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|all)[^;]*to authenticated/is);
  });

  it("purges withdrawn, notified and 12-month-old requests from the scheduled retention", () => {
    expect(sql).toContain("app_private.purge_offer_opening_notifications(p_now)");
    expect(sql).toMatch(/interval '30 days'/);
    expect(sql).toMatch(/interval '12 months'/);
    expect(sql).toContain("|| app_private.purge_information_agent_data(p_now)");
  });
});
