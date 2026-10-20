import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaleCalendarRow } from "@/lib/sale-calendar";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";
import {
  MAX_EMAILS_PER_USER,
  MAX_REMINDER_ITEMS_PER_EMAIL,
  SALE_REMINDER_FAILURE_CODES,
  assertSaleRemindersComplete,
  audienceReminderFor,
  graveWarningFor,
  isSourceCheckStale,
  rotateRecipients,
  runSaleReminders,
  type FollowedSale,
  type SaleReminderFailureCode,
  type SaleReminderStore,
} from "@/lib/sale-reminders";

// Jeudi 3 novembre 2026, 07 h à Paris.
const NOW = new Date("2026-11-03T06:00:00Z");
const env = {
  RESEND_API_KEY: "re_test",
  ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.com>",
  SITE_URL: "https://immojudis.com",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
};
const USER = "7d335032-e935-4550-9347-ed22b0f63449";
const OTHER = "0a0a0a0a-0000-4000-8000-000000000002";
const SALE = "11111111-0000-4000-8000-000000000001";
const SALE_2 = "11111111-0000-4000-8000-000000000002";

function calendarRow(saleId: string, overrides: Partial<SaleCalendarRow> = {}): SaleCalendarRow {
  return {
    id: saleId,
    exportable: true,
    sale_date: "2026-11-10T13:00:00Z",
    date_only: false,
    property_type: "house",
    city: "Bordeaux",
    tribunal_name: "TJ Bordeaux",
    tribunal_city: "Bordeaux",
    updated_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

function change(overrides: Partial<SaleChangeEventSummary> = {}): SaleChangeEventSummary {
  return {
    id: "event-1",
    saleId: SALE,
    watchKind: "favorite",
    watchId: "watch-1",
    eventKind: "status_changed",
    severity: "urgent",
    fingerprint: "status_changed:status:upcoming:postponed",
    summaryLabel: "Statut de la vente modifié",
    changeSummary: { field: "status", previousValue: "upcoming", currentValue: "postponed" },
    detectedAt: "2026-11-03T05:00:00.000Z",
    readAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

// Vérification à la source « récente » pour tous les tests qui ne précisent rien (quel que soit `now`).
const FRESH_CHECK = "2099-01-01T00:00:00Z";

type Setup = {
  /** Dernière vérification à la source par vente ; absent : récente. `null` : inconnue. */
  verified?: Record<string, string | null>;
  consenting?: string[];
  admins?: string[];
  followed?: Record<string, FollowedSale[]>;
  hidden?: string[];
  calendar?: Record<string, SaleCalendarRow | null>;
  events?: Record<string, SaleChangeEventSummary[]>;
  email?: string | null;
};

/** Magasin en mémoire, avec un vrai comportement de journal (une réservation par clé). */
function makeStore(setup: Setup = {}) {
  const journal = new Map<
    string,
    { id: string; status: "pending" | "sent" | "failed"; attempts: number; payload: unknown }
  >();
  let counter = 0;
  const store = {
    listConsentingUserIds: vi.fn(async () => setup.consenting ?? [USER]),
    filterAdminUserIds: vi.fn(
      async (ids: string[]) => new Set(ids.filter((id) => (setup.admins ?? []).includes(id))),
    ),
    followedSales: vi.fn(
      async (userId: string) =>
        setup.followed?.[userId] ?? [{ id: SALE, saleDate: "2026-11-10T13:00:00Z" }],
    ),
    lastVerifiedAt: vi.fn(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [id, id in (setup.verified ?? {}) ? setup.verified![id] : FRESH_CHECK]),
        ),
    ),
    visibleSaleIds: vi.fn(
      async (ids: string[]) => new Set(ids.filter((id) => !(setup.hidden ?? []).includes(id))),
    ),
    calendarEvent: vi.fn(async (saleId: string) =>
      saleId in (setup.calendar ?? {}) ? setup.calendar![saleId] : calendarRow(saleId),
    ),
    recentChangeEvents: vi.fn(async (userId: string) => setup.events?.[userId] ?? []),
    claim: vi.fn(
      async (args: {
        userId: string;
        saleId: string;
        kind: string;
        dedupeKey: string;
        payload: unknown;
      }) => {
        const key = `${args.userId}|${args.saleId}|${args.kind}|${args.dedupeKey}`;
        const existing = journal.get(key);
        if (existing) {
          if (existing.status === "failed" && existing.attempts < 3) {
            existing.status = "pending";
            existing.attempts += 1;
            return existing.id;
          }
          return null;
        }
        counter += 1;
        const id = `journal-${counter}`;
        journal.set(key, { id, status: "pending", attempts: 1, payload: args.payload });
        return id;
      },
    ),
    markSent: vi.fn(async (ids: string[]) => {
      for (const row of journal.values()) if (ids.includes(row.id)) row.status = "sent";
    }),
    markFailed: vi.fn(async (ids: string[], _args: { error: SaleReminderFailureCode }) => {
      for (const row of journal.values()) if (ids.includes(row.id)) row.status = "failed";
    }),
    userEmail: vi.fn(async () =>
      setup.email === undefined ? "investisseur@example.test" : setup.email,
    ),
    purgeJournal: vi.fn(async () => 0),
  } satisfies SaleReminderStore;
  return { store, journal };
}

function resendOk() {
  return vi.fn(
    async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function sentEmails(fetchImpl: ReturnType<typeof vi.fn>) {
  return fetchImpl.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

async function run(
  setup: Setup,
  options: {
    mode?: "off" | "internal" | "on";
    fetchImpl?: ReturnType<typeof resendOk>;
    now?: Date;
  } = {},
) {
  const made = makeStore(setup);
  const fetchImpl = options.fetchImpl ?? resendOk();
  const summary = await runSaleReminders({
    store: made.store,
    now: options.now ?? NOW,
    env,
    fetchImpl,
    mode: options.mode ?? "on",
  });
  return { ...made, fetchImpl, summary, emails: sentEmails(fetchImpl) };
}

describe("runSaleReminders : modes d'envoi", () => {
  it("n'envoie rien, ne lit rien et n'écrit rien en mode off", async () => {
    const { store, fetchImpl, summary } = await run({}, { mode: "off" });
    expect(summary.skipped).toBe("off");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.listConsentingUserIds).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(store.purgeJournal).not.toHaveBeenCalled();
  });

  it("n'envoie rien tant que l'envoi d'emails n'est pas configuré", async () => {
    const made = makeStore();
    const fetchImpl = resendOk();
    const summary = await runSaleReminders({
      store: made.store,
      now: NOW,
      env: {},
      fetchImpl,
      mode: "on",
    });
    expect(summary.skipped).toBe("not_configured");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(made.store.claim).not.toHaveBeenCalled();
  });

  it("lit le mode dans la variable SALE_REMINDERS_MODE quand il n'est pas imposé", async () => {
    const made = makeStore();
    const fetchImpl = resendOk();
    const off = await runSaleReminders({ store: made.store, now: NOW, env, fetchImpl });
    expect(off.skipped).toBe("off");
    const on = await runSaleReminders({
      store: made.store,
      now: NOW,
      env: { ...env, SALE_REMINDERS_MODE: "on" },
      fetchImpl,
    });
    expect(on.emailsSent).toBe(1);
  });

  it("n'écrit qu'aux administrateurs ayant consenti en mode internal, objet préfixé", async () => {
    const { emails, summary, store } = await run(
      {
        consenting: [USER, OTHER],
        admins: [OTHER],
        followed: {
          [USER]: [{ id: SALE, saleDate: "2026-11-10T13:00:00Z" }],
          [OTHER]: [{ id: SALE, saleDate: "2026-11-10T13:00:00Z" }],
        },
        email: "admin@example.test",
      },
      { mode: "internal" },
    );
    expect(summary.recipients).toBe(1);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject.startsWith("[Test interne] ")).toBe(true);
    expect(store.followedSales).toHaveBeenCalledTimes(1);
    expect(store.followedSales).toHaveBeenCalledWith(OTHER);
  });

  it("écrit à toutes les personnes ayant consenti en mode on", async () => {
    const { emails, summary } = await run({ consenting: [USER, OTHER] });
    expect(summary.recipients).toBe(2);
    expect(emails).toHaveLength(2);
    expect(emails[0].subject.startsWith("[Test interne]")).toBe(false);
  });

  it("ne lit que les personnes ayant un consentement : sans consentement, aucun email", async () => {
    const { emails, store, summary } = await run({ consenting: [] });
    expect(emails).toHaveLength(0);
    expect(store.followedSales).not.toHaveBeenCalled();
    expect(summary.recipients).toBe(0);
    expect(store.purgeJournal).toHaveBeenCalledTimes(1);
  });
});

describe("runSaleReminders : rappels d'audience", () => {
  it("rappelle l'audience sept jours avant, avec la date sourcée et la mention à vérifier", async () => {
    const { emails, summary } = await run({});
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe(
      "Votre audience est dans 7 jours — Maison à Bordeaux (Tribunal judiciaire de Bordeaux)",
    );
    expect(emails[0].text).toContain("Audience : mardi 10 novembre 2026 à 14 h 00");
    expect(emails[0].text).toContain("à vérifier auprès de l’avocat poursuivant");
    expect(emails[0].headers["List-Unsubscribe"]).toContain(
      "/api/notification-preferences/unsubscribe",
    );
    expect(emails[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(summary).toMatchObject({ emailsSent: 1, claimed: 1 });
    expect(summary.sentByKind.audience_j7).toBe(1);
  });

  it("ne renvoie jamais le même rappel, même si le cron repasse plusieurs fois", async () => {
    const made = makeStore();
    const first = resendOk();
    const second = resendOk();
    const once = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: first,
      mode: "on",
    });
    const again = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: second,
      mode: "on",
    });
    expect(once.emailsSent).toBe(1);
    expect(again.emailsSent).toBe(0);
    expect(again.candidates).toBe(1);
    expect(again.claimed).toBe(0);
    expect(second).not.toHaveBeenCalled();
  });

  it("rappelle encore la veille (« demain »), puis plus rien le jour même", async () => {
    const made = makeStore();
    const eve = resendOk();
    await runSaleReminders({ store: made.store, now: NOW, env, fetchImpl: resendOk(), mode: "on" });
    const j1 = await runSaleReminders({
      store: made.store,
      now: new Date("2026-11-09T06:00:00Z"),
      env,
      fetchImpl: eve,
      mode: "on",
    });
    expect(j1.sentByKind.audience_j1).toBe(1);
    expect(sentEmails(eve)[0].subject).toContain("Votre audience est demain");
    const sameDay = resendOk();
    const today = await runSaleReminders({
      store: made.store,
      now: new Date("2026-11-10T06:00:00Z"),
      env,
      fetchImpl: sameDay,
      mode: "on",
    });
    expect(today.emailsSent).toBe(0);
    expect(sameDay).not.toHaveBeenCalled();
  });

  it("ne rappelle rien à six, cinq ou huit jours", async () => {
    for (const day of ["2026-11-04", "2026-11-05", "2026-11-02"]) {
      const { emails } = await run({}, { now: new Date(`${day}T06:00:00Z`) });
      expect(emails, day).toHaveLength(0);
    }
  });

  it("n'annonce aucune date que la base ne juge pas sourcée (reportée, contradictoire)", async () => {
    const { emails, store } = await run({
      calendar: { [SALE]: calendarRow(SALE, { exportable: false, sale_date: null }) },
    });
    expect(emails).toHaveLength(0);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("annonce une audience sans heure connue sans inventer d'heure", async () => {
    const { emails } = await run({
      calendar: {
        [SALE]: calendarRow(SALE, { date_only: true, sale_date: "2026-11-09T23:00:00Z" }),
      },
    });
    expect(emails[0].text).toContain("Audience : mardi 10 novembre 2026");
    expect(emails[0].text).not.toMatch(/Audience : mardi 10 novembre 2026 à /);
  });

  it("ignore une vente non publique (quarantaine) sans même lire sa date", async () => {
    const { emails, store } = await run({ hidden: [SALE] });
    expect(emails).toHaveLength(0);
    expect(store.calendarEvent).not.toHaveBeenCalled();
  });

  it("regroupe les rappels d'une personne dans un seul email", async () => {
    const { emails, summary } = await run({
      followed: {
        [USER]: [
          { id: SALE, saleDate: "2026-11-10T13:00:00Z" },
          { id: SALE_2, saleDate: "2026-11-10T13:00:00Z" },
        ],
      },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe("Vos ventes suivies : 2 rappels et changements");
    expect(summary.claimed).toBe(2);
  });

  it("au-delà de dix éléments, un second email part : aucun rappel n'est perdu", async () => {
    const sales = Array.from({ length: MAX_REMINDER_ITEMS_PER_EMAIL + 3 }, (_, index) => ({
      id: `22222222-0000-4000-8000-${String(index).padStart(12, "0")}`,
      saleDate: "2026-11-10T13:00:00Z",
    }));
    const first = await run({ followed: { [USER]: sales } });
    expect(first.summary.claimed).toBe(MAX_REMINDER_ITEMS_PER_EMAIL + 3);
    expect(first.summary.emailsSent).toBe(2);
    expect(first.emails).toHaveLength(2);
    expect(first.summary.deferred).toBe(0);
    expect(() => assertSaleRemindersComplete(first.summary)).not.toThrow();
    const again = await runSaleReminders({
      store: first.store,
      now: NOW,
      env,
      fetchImpl: resendOk(),
      mode: "on",
    });
    expect(again.claimed).toBe(0);
  });

  it("au-delà du plafond d'emails par personne, le reste est compté, fait échouer le passage et part au rattrapage", async () => {
    const total = MAX_REMINDER_ITEMS_PER_EMAIL * MAX_EMAILS_PER_USER + 3;
    const sales = Array.from({ length: total }, (_, index) => ({
      id: `22222222-0000-4000-8000-${String(index).padStart(12, "0")}`,
      saleDate: "2026-11-10T13:00:00Z",
    }));
    const first = await run({ followed: { [USER]: sales } });
    expect(first.summary.emailsSent).toBe(MAX_EMAILS_PER_USER);
    expect(first.summary.deferred).toBe(3);
    expect(() => assertSaleRemindersComplete(first.summary)).toThrow(/non réservé/);

    const catchUpFetch = resendOk();
    const catchUp = await runSaleReminders({
      store: first.store,
      now: NOW,
      env,
      fetchImpl: catchUpFetch,
      mode: "on",
      catchUp: true,
    });
    expect(catchUp.claimed).toBe(3);
    expect(catchUp.emailsSent).toBe(1);
    expect(catchUp.deferred).toBe(0);
    expect(() => assertSaleRemindersComplete(catchUp)).not.toThrow();
  });
});

describe("runSaleReminders : avertissements graves", () => {
  const farSale = { [USER]: [{ id: SALE, saleDate: "2026-12-15T13:00:00Z" }] };

  it("prévient quand une vente suivie est reportée, sans annoncer de date", async () => {
    const { emails, summary } = await run({
      followed: farSale,
      events: { [USER]: [change()] },
      calendar: { [SALE]: calendarRow(SALE, { exportable: false, sale_date: null }) },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe(
      "Vente reportée — Maison à Bordeaux (Tribunal judiciaire de Bordeaux)",
    );
    expect(emails[0].text).toContain("Nouvelle date à confirmer auprès de l’avocat poursuivant.");
    expect(summary.sentByKind.status_changed).toBe(1);
  });

  it("prévient pour une vente retirée ou adjugée, et pas pour un simple retour à « à venir »", async () => {
    for (const [status, expected] of [
      ["withdrawn", "Vente retirée"],
      ["adjudicated", "Vente adjugée"],
    ] as const) {
      const { emails } = await run({
        followed: farSale,
        events: {
          [USER]: [
            change({
              fingerprint: `status_changed:status:upcoming:${status}`,
              changeSummary: { field: "status", previousValue: "upcoming", currentValue: status },
            }),
          ],
        },
      });
      expect(emails[0].subject, status).toContain(expected);
    }
    const quiet = await run({
      followed: farSale,
      events: {
        [USER]: [
          change({
            fingerprint: "status_changed:status:postponed:upcoming",
            changeSummary: {
              field: "status",
              previousValue: "postponed",
              currentValue: "upcoming",
            },
          }),
        ],
      },
    });
    expect(quiet.emails).toHaveLength(0);
  });

  it("prévient quand l'audience change de jour, avec la nouvelle date seulement si elle est sourcée", async () => {
    const moved = change({
      eventKind: "audience_changed",
      fingerprint: "audience_changed:saleDate:2026-12-01T13:00:00Z:2026-12-15T13:00:00Z",
      changeSummary: {
        field: "saleDate",
        previousValue: "2026-12-01T13:00:00Z",
        currentValue: "2026-12-15T13:00:00Z",
      },
    });
    const sourced = await run({
      followed: farSale,
      events: { [USER]: [moved] },
      calendar: { [SALE]: calendarRow(SALE, { sale_date: "2026-12-15T13:00:00Z" }) },
    });
    expect(sourced.emails[0].subject).toContain("La date de l’audience a changé");
    expect(sourced.emails[0].text).toContain("Nouvelle date : mardi 15 décembre 2026");
    expect(sourced.emails[0].text).toContain("à vérifier auprès de l’avocat poursuivant");
    expect(sourced.summary.sentByKind.date_changed).toBe(1);

    const unsourced = await run({
      followed: farSale,
      events: { [USER]: [moved] },
      calendar: { [SALE]: calendarRow(SALE, { exportable: false, sale_date: null }) },
    });
    expect(unsourced.emails[0].text).toContain("Nouvelle date à confirmer");
    expect(unsourced.emails[0].text).not.toContain("15 décembre 2026");
  });

  it("ne prévient pas pour un simple changement d'heure le même jour, ni pour une date passée", async () => {
    const sameDay = change({
      eventKind: "audience_changed",
      fingerprint: "audience_changed:saleDate:a:b",
      changeSummary: {
        field: "saleDate",
        previousValue: "2026-12-15T09:00:00Z",
        currentValue: "2026-12-15T13:00:00Z",
      },
    });
    const past = change({
      eventKind: "audience_changed",
      fingerprint: "audience_changed:saleDate:c:d",
      changeSummary: {
        field: "saleDate",
        previousValue: "2026-12-15T13:00:00Z",
        currentValue: "2026-10-01T13:00:00Z",
      },
    });
    const { emails } = await run({ followed: farSale, events: { [USER]: [sameDay, past] } });
    expect(emails).toHaveLength(0);
  });

  it("ne prévient jamais pour le prix, les documents ou le score", async () => {
    const events = [
      change({
        eventKind: "price_changed",
        fingerprint: "price_changed:startingPriceEur:100:50",
        changeSummary: { field: "startingPriceEur", previousValue: 100, currentValue: 50 },
      }),
      change({
        eventKind: "documents_changed",
        fingerprint: "documents_changed:documentSignature:a:b",
        changeSummary: { field: "documentSignature", previousValue: "a", currentValue: "b" },
      }),
      change({
        eventKind: "score_changed",
        fingerprint: "score_changed:investmentScore:50:70",
        changeSummary: { field: "investmentScore", previousValue: 50, currentValue: 70 },
      }),
    ];
    const { emails } = await run({ followed: farSale, events: { [USER]: events } });
    expect(emails).toHaveLength(0);
  });

  it("ne renvoie pas le même avertissement : une alerte enregistrée pour deux suivis donne un seul email", async () => {
    const twice = [change(), change({ id: "event-2", watchKind: "workspace", watchId: "watch-2" })];
    const made = makeStore({ followed: farSale, events: { [USER]: twice } });
    const fetchImpl = resendOk();
    const first = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl,
      mode: "on",
    });
    expect(first.claimed).toBe(1);
    const second = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl,
      mode: "on",
    });
    expect(second.claimed).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("met les avertissements avant les rappels d'audience", async () => {
    const { emails } = await run({
      followed: {
        [USER]: [
          { id: SALE, saleDate: "2026-12-15T13:00:00Z" },
          { id: SALE_2, saleDate: "2026-11-10T13:00:00Z" },
        ],
      },
      events: { [USER]: [change()] },
    });
    const body: string = emails[0].text;
    expect(body.indexOf("Vente reportée")).toBeLessThan(
      body.indexOf("Votre audience est dans 7 jours"),
    );
  });
});

describe("runSaleReminders : échecs", () => {
  it("garde la trace d'un envoi refusé et le réessaie au passage suivant, trois fois au plus", async () => {
    const made = makeStore();
    const refused = vi.fn(
      async () => new Response(JSON.stringify({ message: "refusé" }), { status: 500 }),
    ) as unknown as typeof fetch;
    const first = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: refused,
      mode: "on",
    });
    expect(first).toMatchObject({ emailsSent: 0, emailsFailed: 1 });
    expect(made.store.markFailed).toHaveBeenCalledTimes(1);
    // Le journal ne garde qu'un code court, jamais la réponse du prestataire.
    expect(made.store.markFailed).toHaveBeenCalledWith(expect.any(Array), { error: "send_failed" });
    expect(JSON.stringify(made.store.markFailed.mock.calls)).not.toContain("refusé");
    expect([...made.journal.values()][0].status).toBe("failed");

    const ok = resendOk();
    const retry = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: ok,
      mode: "on",
    });
    expect(retry.emailsSent).toBe(1);
    expect([...made.journal.values()][0].status).toBe("sent");
    expect([...made.journal.values()][0].attempts).toBe(2);
  });

  it("marque l'échec quand la personne n'a pas d'adresse email confirmée, avec une raison explicite", async () => {
    // `readUserEmail` rend `null` pour une adresse absente comme pour une adresse non confirmée.
    const { summary, store, fetchImpl } = await run({ email: null });
    expect(summary.emailsFailed).toBe(1);
    expect(store.markFailed).toHaveBeenCalledTimes(1);
    expect(store.markFailed).toHaveBeenCalledWith(expect.any(Array), {
      error: "email_unavailable",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("marque une lecture d'adresse impossible d'un code court, sans recopier le message d'erreur", async () => {
    const made = makeStore();
    made.store.userEmail.mockRejectedValueOnce(new Error("secret interne de la base"));
    const summary = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: resendOk(),
      mode: "on",
    });
    expect(summary.emailsFailed).toBe(1);
    expect(made.store.markFailed).toHaveBeenCalledWith(expect.any(Array), {
      error: "email_lookup_failed",
    });
  });

  it("n'écrit au journal que des codes de la liste fermée, même quand le prestataire est bavard", async () => {
    const made = makeStore();
    const verbose = vi.fn(
      async () => new Response(JSON.stringify({ message: "x".repeat(2_000) }), { status: 422 }),
    ) as unknown as typeof fetch;
    await runSaleReminders({ store: made.store, now: NOW, env, fetchImpl: verbose, mode: "on" });
    expect(made.store.markFailed).toHaveBeenCalled();
    for (const [, { error }] of made.store.markFailed.mock.calls) {
      expect(SALE_REMINDER_FAILURE_CODES).toContain(error);
    }
  });

  it("fait échouer le passage quand une lecture est impossible, au lieu de conclure qu'il n'y a rien", async () => {
    const made = makeStore();
    made.store.followedSales.mockRejectedValueOnce(new Error("base injoignable"));
    await expect(
      runSaleReminders({ store: made.store, now: NOW, env, fetchImpl: resendOk(), mode: "on" }),
    ).rejects.toThrow("base injoignable");
  });

  it("purge le journal en fin de passage", async () => {
    const made = makeStore();
    made.store.purgeJournal.mockResolvedValueOnce(4);
    const summary = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: resendOk(),
      mode: "on",
    });
    expect(summary.purgedJournalRows).toBe(4);
  });
});

describe("runSaleReminders : passage incomplet", () => {
  afterEach(() => vi.restoreAllMocks());

  it("un passage interrompu par le délai est marqué tronqué et fait échouer le passage", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(1_000_000);
    const { summary, fetchImpl } = await run({});
    expect(summary.truncated).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => assertSaleRemindersComplete(summary)).toThrow(/interrompu/);
  });

  it("un envoi en échec fait échouer le passage, un passage complet non", async () => {
    const made = makeStore();
    const refused = vi.fn(
      async () => new Response(JSON.stringify({ message: "refusé" }), { status: 500 }),
    ) as unknown as typeof fetch;
    const failed = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: refused,
      mode: "on",
    });
    expect(() => assertSaleRemindersComplete(failed)).toThrow(/1 envoi\(s\) en échec/);

    const retry = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: resendOk(),
      mode: "on",
      catchUp: true,
    });
    expect(retry.emailsSent).toBe(1);
    expect(() => assertSaleRemindersComplete(retry)).not.toThrow();
  });

  it("les modes off et non configuré ne font jamais échouer le passage", async () => {
    const { summary } = await run({}, { mode: "off" });
    expect(() => assertSaleRemindersComplete(summary)).not.toThrow();
  });
});

describe("rotateRecipients", () => {
  const ids = Array.from({ length: 9 }, (_, index) => `user-${index}`);
  const day = (offset: number) => new Date(Date.UTC(2026, 10, 3 + offset, 6, 0));

  it("garde les mêmes personnes, quel que soit l'ordre reçu", () => {
    expect([...rotateRecipients([...ids].reverse(), day(0))].sort()).toEqual(ids);
    expect(rotateRecipients([...ids].reverse(), day(0))).toEqual(rotateRecipients(ids, day(0)));
  });

  it("ne commence pas par les mêmes personnes d'un jour à l'autre", () => {
    const firsts = new Set(
      Array.from({ length: 6 }, (_, offset) => rotateRecipients(ids, day(offset))[0]),
    );
    expect(firsts.size).toBeGreaterThan(3);
  });

  it("le rattrapage part d'ailleurs que le premier passage du même jour", () => {
    expect(rotateRecipients(ids, day(0), true)[0]).not.toBe(rotateRecipients(ids, day(0))[0]);
  });

  it("un passage lit les personnes dans l'ordre décalé", async () => {
    const consenting = ids.map((_id, index) => `0a0a0a0a-0000-4000-8000-00000000000${index}`);
    const first = await run({
      consenting,
      followed: Object.fromEntries(consenting.map((id) => [id, []])),
    });
    const later = await run(
      { consenting, followed: Object.fromEntries(consenting.map((id) => [id, []])) },
      { now: day(2) },
    );
    const order = (made: typeof first) =>
      made.store.followedSales.mock.calls.map(([userId]) => userId);
    expect(order(first)).toHaveLength(9);
    expect([...order(first)].sort()).toEqual([...order(later)].sort());
    expect(order(first)[0]).not.toBe(order(later)[0]);
  });
});

describe("audienceReminderFor", () => {
  it("compte en jours civils de Paris, quelle que soit l'heure du passage", () => {
    const row = calendarRow(SALE, { sale_date: "2026-11-10T23:30:00Z" }); // 11 novembre 00 h 30 à Paris
    expect(audienceReminderFor(row, new Date("2026-11-04T05:00:00Z"))?.kind).toBe("audience_j7");
    expect(audienceReminderFor(row, new Date("2026-11-03T05:00:00Z"))).toBeNull();
  });

  it("ne rappelle rien sans date sourcée", () => {
    expect(audienceReminderFor(calendarRow(SALE, { exportable: false }), NOW)).toBeNull();
    expect(audienceReminderFor(calendarRow(SALE, { sale_date: null }), NOW)).toBeNull();
    expect(audienceReminderFor(calendarRow(SALE, { sale_date: "n'importe quoi" }), NOW)).toBeNull();
  });
});

describe("retrait déduit de l'absence de l'annonce à la source", () => {
  const absence = () =>
    change({
      fingerprint: "status_changed:status:upcoming:withdrawn",
      changeSummary: {
        field: "status",
        previousValue: "upcoming",
        currentValue: "withdrawn",
        reason: "source_absence",
      },
    });

  it("est annoncé comme une annonce disparue de la source, pas comme une vente retirée", () => {
    expect(graveWarningFor(absence(), NOW)).toEqual({
      kind: "status_changed",
      headline: "Annonce disparue de la source",
      sourceAbsence: true,
    });
  });

  it("donne un email qui ne parle pas de vente retirée et renvoie à l'avocat poursuivant", async () => {
    const { emails } = await run({
      followed: { [USER]: [{ id: SALE, saleDate: "2026-12-15T13:00:00Z" }] },
      events: { [USER]: [absence()] },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Annonce disparue de la source");
    expect(emails[0].subject).not.toMatch(/retir/i);
    expect(emails[0].text).toContain("À vérifier auprès de l’avocat poursuivant.");
    expect(emails[0].text).not.toMatch(/retir/i);
  });
});

describe("graveWarningFor", () => {
  it("ne retient que la date, et le statut reporté, retiré, annulé ou adjugé", () => {
    expect(graveWarningFor(change(), NOW)?.kind).toBe("status_changed");
    expect(
      graveWarningFor(
        change({
          changeSummary: { field: "status", previousValue: "upcoming", currentValue: "past" },
        }),
        NOW,
      ),
    ).toBeNull();
    expect(
      graveWarningFor(
        change({
          changeSummary: { field: "status", previousValue: "upcoming", currentValue: "cancelled" },
        }),
        NOW,
      )?.headline,
    ).toBe("Vente annulée");
  });
});

describe("runSaleReminders : fraîcheur de la vérification à la source", () => {
  const FRESH = new Date(NOW.getTime() - 35 * 3_600_000).toISOString();
  const STALE = new Date(NOW.getTime() - 37 * 3_600_000).toISOString();

  it("envoie le rappel quand la vente a été revérifiée depuis moins de 36 h", async () => {
    const { emails, summary } = await run({ verified: { [SALE]: FRESH } });
    expect(emails).toHaveLength(1);
    expect(summary).toMatchObject({ audienceDue: 1, skippedStale: 0 });
  });

  it("n'envoie ni J-7 ni J-1 quand la dernière vérification date de plus de 36 h", async () => {
    const seven = await run({ verified: { [SALE]: STALE } });
    expect(seven.emails).toHaveLength(0);
    expect(seven.store.claim).not.toHaveBeenCalled();
    expect(seven.summary).toMatchObject({ audienceDue: 1, skippedStale: 1, candidates: 0 });

    const eve = new Date("2026-11-09T06:00:00Z");
    const one = await run(
      { verified: { [SALE]: new Date(eve.getTime() - 40 * 3_600_000).toISOString() } },
      { now: eve },
    );
    expect(one.emails).toHaveLength(0);
    expect(one.summary).toMatchObject({ audienceDue: 1, skippedStale: 1 });
  });

  it("traite une vérification inconnue comme périmée", async () => {
    const { emails, summary } = await run({ verified: { [SALE]: null } });
    expect(emails).toHaveLength(0);
    expect(summary.skippedStale).toBe(1);
  });

  it("ne retient pas une vente écartée : elle est rappelée dès que la vérification est fraîche", async () => {
    const made = makeStore({ verified: { [SALE]: STALE } });
    const first = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: resendOk(),
      mode: "on",
    });
    expect(first.emailsSent).toBe(0);
    made.store.lastVerifiedAt.mockResolvedValueOnce(new Map([[SALE, FRESH]]));
    const catchUp = await runSaleReminders({
      store: made.store,
      now: NOW,
      env,
      fetchImpl: resendOk(),
      mode: "on",
      catchUp: true,
    });
    expect(catchUp.emailsSent).toBe(1);
  });

  it("ne touche pas aux avertissements graves (ils viennent des événements, pas de la date stockée)", async () => {
    const { emails } = await run({
      followed: { [USER]: [{ id: SALE, saleDate: "2026-12-15T13:00:00Z" }] },
      events: { [USER]: [change()] },
      verified: { [SALE]: STALE },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Vente reportée");
  });

  it("n'interroge la vérification que pour les ventes de la fenêtre utile", async () => {
    const { store } = await run({
      followed: {
        [USER]: [
          { id: SALE, saleDate: "2026-11-10T13:00:00Z" },
          { id: SALE_2, saleDate: "2027-03-01T13:00:00Z" },
        ],
      },
    });
    expect(store.lastVerifiedAt).toHaveBeenCalledTimes(1);
    expect(store.lastVerifiedAt).toHaveBeenCalledWith([SALE]);
  });

  it("fait échouer le passage quand plus de 20 % des rappels dus sont écartés", async () => {
    const sales = Array.from({ length: 10 }, (_, index) => ({
      id: `22222222-0000-4000-8000-${String(index).padStart(12, "0")}`,
      saleDate: "2026-11-10T13:00:00Z",
    }));
    const stale = (count: number) =>
      Object.fromEntries(sales.slice(0, count).map(({ id }) => [id, STALE]));

    const twoOfTen = await run({ followed: { [USER]: sales }, verified: stale(2) });
    expect(twoOfTen.summary).toMatchObject({ audienceDue: 10, skippedStale: 2 });
    expect(twoOfTen.summary.claimed).toBe(8);
    expect(() => assertSaleRemindersComplete(twoOfTen.summary)).not.toThrow();

    const threeOfTen = await run({ followed: { [USER]: sales }, verified: stale(3) });
    expect(threeOfTen.summary.skippedStale).toBe(3);
    // Les rappels frais sont partis ; le passage échoue pour que la supervision le voie.
    expect(threeOfTen.summary.emailsSent).toBe(1);
    expect(() => assertSaleRemindersComplete(threeOfTen.summary)).toThrow(/3 rappel\(s\).*10/);
  });

  it("isSourceCheckStale : seuil de 36 h, inconnu ou illisible = périmé", () => {
    expect(isSourceCheckStale(FRESH, NOW)).toBe(false);
    expect(isSourceCheckStale(STALE, NOW)).toBe(true);
    expect(isSourceCheckStale(null, NOW)).toBe(true);
    expect(isSourceCheckStale("n'importe quoi", NOW)).toBe(true);
    expect(isSourceCheckStale(new Date(NOW.getTime() - 36 * 3_600_000).toISOString(), NOW)).toBe(
      false,
    );
  });
});

describe("runSaleReminders : ventes suivies nombreuses", () => {
  const sale = (index: number, date: string) => ({
    id: `33333333-0000-4000-8000-${String(index).padStart(12, "0")}`,
    saleDate: date,
  });

  it("ne retient que les ventes de la fenêtre utile : 400 ventes lointaines ne masquent pas celle de J-7", async () => {
    const far = Array.from({ length: 400 }, (_, index) => sale(index, "2027-02-01T13:00:00Z"));
    const near = sale(999, "2026-11-10T13:00:00Z");
    const { emails, summary } = await run({ followed: { [USER]: [...far, near] } });
    expect(emails).toHaveLength(1);
    expect(summary.claimed).toBe(1);
    expect(summary.truncatedUsers).toBe(0);
  });

  it("compte les personnes dont plus de 300 ventes tombent dans la fenêtre, les plus proches d'abord", async () => {
    const sevenDays = Array.from({ length: 300 }, (_, index) =>
      sale(index, "2026-11-10T13:00:00Z"),
    );
    const tomorrow = sale(900, "2026-11-04T13:00:00Z");
    const other = sale(901, "2026-11-10T13:00:00Z");
    const { store, summary } = await run({
      followed: {
        [USER]: [...sevenDays, other, tomorrow],
        [OTHER]: [sale(1, "2026-11-10T13:00:00Z")],
      },
      consenting: [USER, OTHER],
    });
    expect(summary.truncatedUsers).toBe(1);
    const examined = store.lastVerifiedAt.mock.calls.find(([ids]) => ids.length === 300)?.[0] ?? [];
    expect(examined).toHaveLength(300);
    // La vente de demain est examinée avant celles de dans une semaine.
    expect(examined[0]).toBe(tomorrow.id);
    expect(examined).not.toContain(other.id);
  });
});
