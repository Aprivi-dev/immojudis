import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  buildOfferOpeningPatch,
  buildOfferOpeningSurveyPatch,
  OFFER_OPENING_CONSENT_TEXT,
  OFFER_OPENING_CONSENT_VERSION,
  OFFER_OPENING_SURVEY_VERSION,
  offerOpeningNotificationSchema,
  offerOpeningSurveySchema,
  setOfferOpeningNotification,
  setOfferOpeningSurvey,
} from "@/lib/offer-opening-notification";
import { PublicApiError } from "@/lib/api-errors";

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
      // Les réponses facultatives partent avec la demande.
      survey_profile: null,
      survey_sales_per_month: null,
      survey_price_too_expensive_eur: null,
      survey_price_cheap_eur: null,
      survey_interview_accepted: false,
      survey_interview_consented_at: null,
      survey_text_version: null,
      survey_answered_at: null,
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
    expect(response.notification).toEqual({
      requested: true,
      consentedAt: timestamp,
      survey: null,
    });
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

describe("liste d'attente qualifiée : questions facultatives", () => {
  const answers = {
    surveyTextVersion: OFFER_OPENING_SURVEY_VERSION,
    profile: "marchand_de_biens",
    salesPerMonth: 8,
    priceTooExpensiveEur: 60,
    priceCheapEur: 15,
    interviewAccepted: true,
  };

  it("accepte des réponses complètes, vides ou partielles : rien n'est obligatoire", () => {
    expect(offerOpeningSurveySchema.parse(answers)).toMatchObject({ profile: "marchand_de_biens" });
    expect(
      offerOpeningSurveySchema.parse({ surveyTextVersion: OFFER_OPENING_SURVEY_VERSION }),
    ).toEqual({
      surveyTextVersion: OFFER_OPENING_SURVEY_VERSION,
      profile: null,
      salesPerMonth: null,
      priceTooExpensiveEur: null,
      priceCheapEur: null,
      interviewAccepted: false,
    });
    expect(
      offerOpeningSurveySchema.parse({
        surveyTextVersion: OFFER_OPENING_SURVEY_VERSION,
        profile: null,
        salesPerMonth: null,
        priceCheapEur: 20,
      }),
    ).toMatchObject({ profile: null, salesPerMonth: null, priceCheapEur: 20 });
  });

  it("la case d'entretien n'est jamais cochée par défaut", () => {
    expect(
      offerOpeningSurveySchema.parse({ surveyTextVersion: OFFER_OPENING_SURVEY_VERSION })
        .interviewAccepted,
    ).toBe(false);
  });

  it("refuse un profil inconnu, des valeurs hors bornes et des champs en trop", () => {
    const parse = (extra: Record<string, unknown>) =>
      offerOpeningSurveySchema.safeParse({ ...answers, ...extra }).success;
    expect(parse({ profile: "banquier" })).toBe(false);
    expect(parse({ salesPerMonth: -1 })).toBe(false);
    expect(parse({ salesPerMonth: 501 })).toBe(false);
    expect(parse({ salesPerMonth: 2.5 })).toBe(false);
    expect(parse({ priceCheapEur: 1001 })).toBe(false);
    expect(parse({ priceTooExpensiveEur: "cher" })).toBe(false);
    expect(parse({ role: "admin" })).toBe(false);
  });

  it("exige la version du texte que la personne a vu", () => {
    expect(
      offerOpeningSurveySchema.safeParse({ ...answers, surveyTextVersion: "ancienne" }).success,
    ).toBe(false);
    const { surveyTextVersion: _omitted, ...withoutVersion } = answers;
    expect(offerOpeningSurveySchema.safeParse(withoutVersion).success).toBe(false);
  });

  it("date l'accord à l'entretien une fois, et l'efface quand la case est décochée", () => {
    const input = offerOpeningSurveySchema.parse(answers);
    const first = buildOfferOpeningSurveyPatch({
      current: { survey_interview_accepted: false, survey_interview_consented_at: null },
      input,
      timestamp,
    });
    expect(first).toMatchObject({
      survey_profile: "marchand_de_biens",
      survey_sales_per_month: 8,
      survey_price_too_expensive_eur: 60,
      survey_price_cheap_eur: 15,
      survey_interview_accepted: true,
      survey_interview_consented_at: timestamp,
      survey_text_version: OFFER_OPENING_SURVEY_VERSION,
      survey_answered_at: timestamp,
    });

    const again = buildOfferOpeningSurveyPatch({
      current: {
        survey_interview_accepted: true,
        survey_interview_consented_at: "2026-10-01T00:00:00.000Z",
      },
      input,
      timestamp,
    });
    expect(again.survey_interview_consented_at).toBe("2026-10-01T00:00:00.000Z");

    const withdrawn = buildOfferOpeningSurveyPatch({
      current: {
        survey_interview_accepted: true,
        survey_interview_consented_at: "2026-10-01T00:00:00.000Z",
      },
      input: offerOpeningSurveySchema.parse({ ...answers, interviewAccepted: false }),
      timestamp,
    });
    expect(withdrawn).toMatchObject({
      survey_interview_accepted: false,
      survey_interview_consented_at: null,
    });
  });

  function surveyAdmin(current: Record<string, unknown> | null) {
    const update = vi.fn((row: Record<string, unknown>) => ({
      eq: () => ({
        select: () => ({
          single: async () => ({ data: { ...current, ...row }, error: null }),
        }),
      }),
    }));
    const admin = {
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: current, error: null }) }),
        }),
        update,
      })),
    } as unknown as SupabaseClient<Database>;
    return { admin, update };
  }

  it("enregistre les réponses par le client de service, avec l'horloge du serveur", async () => {
    const { admin, update } = surveyAdmin({
      user_id: "user-1",
      notify_enabled: true,
      consented_at: "2026-10-01T00:00:00.000Z",
      survey_interview_accepted: false,
      survey_interview_consented_at: null,
    });
    const response = await setOfferOpeningSurvey({
      auth: { userId: "user-1" },
      admin,
      input: offerOpeningSurveySchema.parse(answers),
      now: new Date(timestamp),
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        survey_profile: "marchand_de_biens",
        survey_interview_consented_at: timestamp,
        survey_answered_at: timestamp,
      }),
    );
    expect(response.notification).toMatchObject({
      requested: true,
      survey: {
        profile: "marchand_de_biens",
        salesPerMonth: 8,
        priceTooExpensiveEur: 60,
        priceCheapEur: 15,
        interviewAccepted: true,
        answeredAt: timestamp,
      },
    });
  });

  it("ne s'enregistre pas sans demande d'information active (rien ne passe par l'inscription)", async () => {
    for (const current of [
      null,
      { user_id: "user-1", notify_enabled: false, consented_at: "2026-10-01T00:00:00.000Z" },
    ]) {
      const { admin, update } = surveyAdmin(current);
      await expect(
        setOfferOpeningSurvey({
          auth: { userId: "user-1" },
          admin,
          input: offerOpeningSurveySchema.parse(answers),
        }),
      ).rejects.toBeInstanceOf(PublicApiError);
      expect(update).not.toHaveBeenCalled();
    }
  });
});

describe("offer opening survey migration", () => {
  const sql = readFileSync("supabase/migrations/20261028120200_offer_opening_survey.sql", "utf8");

  it("ajoute des colonnes facultatives à la table de la demande, avec leurs bornes", () => {
    for (const column of [
      "survey_profile text",
      "survey_sales_per_month integer",
      "survey_price_too_expensive_eur integer",
      "survey_price_cheap_eur integer",
      "survey_interview_accepted boolean not null default false",
      "survey_interview_consented_at timestamptz",
      "survey_text_version text",
      "survey_answered_at timestamptz",
    ]) {
      expect(sql).toContain(`add column if not exists ${column}`);
    }
    expect(sql).toMatch(
      /survey_profile in \('particulier', 'marchand_de_biens', 'avocat', 'autre'\)/,
    );
  });

  it("garde les écritures au serveur : aucun droit d'écriture pour le navigateur", () => {
    const code = sql.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/grant[^;]*\b(insert|update|delete)\b[^;]*to authenticated/i);
    expect(code).not.toMatch(/create policy/i);
  });

  it("les profils de la base sont ceux de l'interface", async () => {
    const { OFFER_OPENING_SURVEY_PROFILES } = await import("@/lib/offer-opening-consent");
    for (const { value } of OFFER_OPENING_SURVEY_PROFILES) expect(sql).toContain(`'${value}'`);
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
