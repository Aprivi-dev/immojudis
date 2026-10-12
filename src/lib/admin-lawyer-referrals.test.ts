import { describe, expect, it } from "vitest";
import {
  adminLawyerReferralUpdateInputSchema,
  adminLawyerReferralUpdatePayload,
  buildLawyerReferralEmailMessage,
  isReferencedLawyerPlacementActive,
  shouldDispatchReferencedLawyerEmail,
} from "@/lib/admin-lawyer-referrals";

describe("admin lawyer referral requests", () => {
  it("normalizes update input and records assignment/sent timestamps", () => {
    const input = adminLawyerReferralUpdateInputSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      status: "sent_to_lawyer",
      requestedLawyerId: "22222222-2222-4222-8222-222222222222",
      adminNotes: "Envoyé au cabinet partenaire.",
    });

    const payload = adminLawyerReferralUpdatePayload({
      input,
      updatedBy: "33333333-3333-4333-8333-333333333333",
      now: new Date("2026-07-06T18:00:00.000Z"),
      existing: {
        status: "manual_review",
        matching_status: "manual_review",
        requested_lawyer_id: null,
        assigned_at: null,
        sent_at: null,
        responded_at: null,
        metadata: { source: "sale_detail" },
      },
    });

    expect(payload).toMatchObject({
      status: "sent_to_lawyer",
      requested_lawyer_id: "22222222-2222-4222-8222-222222222222",
      matching_status: "matched",
      admin_notes: "Envoyé au cabinet partenaire.",
      assigned_at: "2026-07-06T18:00:00.000Z",
      sent_at: "2026-07-06T18:00:00.000Z",
      responded_at: null,
      metadata: {
        source: "sale_detail",
        last_admin_update: {
          updated_by: "33333333-3333-4333-8333-333333333333",
          updated_at: "2026-07-06T18:00:00.000Z",
          previous_status: "manual_review",
          next_status: "sent_to_lawyer",
          requested_lawyer_id: "22222222-2222-4222-8222-222222222222",
        },
      },
    });
  });

  it("keeps existing timestamps and marks response once", () => {
    const input = adminLawyerReferralUpdateInputSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      status: "responded",
      requestedLawyerId: "",
      adminNotes: "",
    });

    const payload = adminLawyerReferralUpdatePayload({
      input,
      updatedBy: "33333333-3333-4333-8333-333333333333",
      now: new Date("2026-07-06T19:00:00.000Z"),
      existing: {
        status: "sent_to_lawyer",
        matching_status: "matched",
        requested_lawyer_id: "22222222-2222-4222-8222-222222222222",
        assigned_at: "2026-07-06T18:00:00.000Z",
        sent_at: "2026-07-06T18:05:00.000Z",
        responded_at: null,
        metadata: null,
      },
    });

    expect(payload).toMatchObject({
      status: "responded",
      requested_lawyer_id: null,
      matching_status: "matched",
      admin_notes: null,
      assigned_at: "2026-07-06T18:00:00.000Z",
      sent_at: "2026-07-06T18:05:00.000Z",
      responded_at: "2026-07-06T19:00:00.000Z",
    });
  });

  it("reopens delivery for a failed attempt or a reassigned lawyer", () => {
    const existing = {
      sent_at: "2026-07-06T18:05:00.000Z",
      requested_lawyer_id: "22222222-2222-4222-8222-222222222222",
      metadata: {
        lawyer_email_delivery: {
          status: "failed",
          provider: "resend",
          recipient: "old@example.test",
          messageId: null,
          detail: "timeout",
          attemptedAt: "2026-07-06T18:05:00.000Z",
        },
      },
    };

    expect(
      shouldDispatchReferencedLawyerEmail({
        existing,
        request: {
          status: "sent_to_lawyer",
          requested_lawyer_id: existing.requested_lawyer_id,
          metadata: existing.metadata,
        },
      }),
    ).toBe(true);
    expect(
      shouldDispatchReferencedLawyerEmail({
        existing: {
          ...existing,
          metadata: {
            lawyer_email_delivery: {
              ...existing.metadata.lawyer_email_delivery,
              status: "sent",
            },
          },
        },
        request: {
          status: "sent_to_lawyer",
          requested_lawyer_id: existing.requested_lawyer_id,
          metadata: existing.metadata,
        },
      }),
    ).toBe(false);
    expect(
      shouldDispatchReferencedLawyerEmail({
        existing,
        request: {
          status: "sent_to_lawyer",
          requested_lawyer_id: "44444444-4444-4444-8444-444444444444",
          metadata: existing.metadata,
        },
      }),
    ).toBe(true);
  });

  it("refreshes sent_at when an already sent request is reassigned", () => {
    const input = adminLawyerReferralUpdateInputSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      status: "sent_to_lawyer",
      requestedLawyerId: "44444444-4444-4444-8444-444444444444",
    });

    const payload = adminLawyerReferralUpdatePayload({
      input,
      updatedBy: "33333333-3333-4333-8333-333333333333",
      now: new Date("2026-07-06T20:00:00.000Z"),
      existing: {
        status: "sent_to_lawyer",
        matching_status: "matched",
        requested_lawyer_id: "22222222-2222-4222-8222-222222222222",
        assigned_at: "2026-07-06T18:00:00.000Z",
        sent_at: "2026-07-06T18:05:00.000Z",
        responded_at: null,
        metadata: null,
      },
    });

    expect(payload.sent_at).toBe("2026-07-06T20:00:00.000Z");
    expect(payload.requested_lawyer_id).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("builds an email for the assigned referenced lawyer", () => {
    const message = buildLawyerReferralEmailMessage({
      from: "Immojudis <alertes@immojudis.fr>",
      recipientEmail: "avocat@example.test",
      appUrl: "https://immojudis.example",
      lawyer: {
        display_name: "Me Référencé",
      },
      request: {
        id: "11111111-1111-4111-8111-111111111111",
        requester_email: "acheteur@example.test",
        phone: "0600000000",
        preferred_contact_method: "either",
        message: "Je souhaite préparer l'audience.",
        financing_ready: true,
        max_bid_eur: 126_000,
        admin_notes: "Dossier à traiter rapidement.",
        sale_snapshot: {
          id: "22222222-2222-4222-8222-222222222222",
          title: "Appartement judiciaire",
          city: "Bordeaux",
          department: "33",
          lawyer_name: "Me Source",
          lawyer_contact: "source@example.test",
        },
      },
    });

    expect(message.to).toBe("avocat@example.test");
    expect(message.subject).toContain("Appartement judiciaire");
    expect(message.text).toContain("acheteur@example.test");
    expect(message.text).toContain("126");
    expect(message.text).toContain("Merci de vérifier");
    expect(message.text).not.toContain("source@example.test");
    expect(message.html).toContain("Mise en relation Immojudis");
    expect(message.html).not.toContain("Me Source");
  });

  it("rejects a lawyer outside the paid placement window", () => {
    const now = new Date("2026-07-06T12:00:00.000Z");
    const base = {
      status: "active" as const,
      paid_placement_status: "active" as const,
      accepts_judicial_auctions: true,
    };

    expect(
      isReferencedLawyerPlacementActive(
        {
          ...base,
          paid_placement_starts_at: "2026-07-07T00:00:00.000Z",
          paid_placement_ends_at: null,
        },
        now,
      ),
    ).toBe(false);
    expect(
      isReferencedLawyerPlacementActive(
        {
          ...base,
          paid_placement_starts_at: null,
          paid_placement_ends_at: "2026-07-05T23:59:59.000Z",
        },
        now,
      ),
    ).toBe(false);
    expect(
      isReferencedLawyerPlacementActive(
        {
          ...base,
          paid_placement_starts_at: "2026-07-01T00:00:00.000Z",
          paid_placement_ends_at: "2026-07-31T23:59:59.000Z",
        },
        now,
      ),
    ).toBe(true);
  });
});
