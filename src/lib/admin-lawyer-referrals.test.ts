import { describe, expect, it } from "vitest";
import {
  adminLawyerReferralUpdateInputSchema,
  adminLawyerReferralUpdatePayload,
  buildLawyerReferralEmailMessage,
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

  it("builds an email for the assigned referenced lawyer", () => {
    const message = buildLawyerReferralEmailMessage({
      from: "ImmoJudis <alertes@immojudis.fr>",
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
    expect(message.html).toContain("Mise en relation ImmoJudis");
    expect(message.html).not.toContain("Me Source");
  });
});
