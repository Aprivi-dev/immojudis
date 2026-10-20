import { describe, expect, it, vi } from "vitest";
import type { SaleCalendarRow } from "@/lib/sale-calendar";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";
import type { FollowedSale } from "@/lib/sale-reminders";
import {
  AUDIENCE_WINDOW_DAYS,
  MAX_AUDIENCES,
  MAX_CHANGES,
  MAX_DEFERRAL_DAYS,
  MAX_NEW_SALES,
  assertWeeklyDigestComplete,
  buildDigestContent,
  dueDigest,
  isoWeekKey,
  isoWeekday,
  parisDayStart,
  runWeeklyDigest,
  upcomingAudienceFor,
  type NewSaleSummary,
  type WeeklyDigestFailureCode,
  type WeeklyDigestRunSummary,
  type WeeklyDigestStore,
} from "@/lib/weekly-digest";

// Mardi 3 novembre 2026, 11 h 30 à Paris (semaine ISO 45).
const TUESDAY = new Date("2026-11-03T10:30:00Z");
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
const FRESH_CHECK = "2099-01-01T00:00:00Z";

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
    eventKind: "price_changed",
    severity: "important",
    fingerprint: "price_changed:startingPriceEur:120000:100000",
    summaryLabel: "Mise à prix modifiée",
    changeSummary: { field: "startingPriceEur", previousValue: 120000, currentValue: 100000 },
    detectedAt: "2026-11-01T05:00:00.000Z",
    readAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

type Setup = {
  users?: Array<{ userId: string; weekday: number }>;
  admins?: string[];
  emailedToday?: string[];
  settled?: string[];
  followed?: Record<string, FollowedSale[]>;
  verified?: Record<string, string | null>;
  hidden?: string[];
  calendar?: Record<string, SaleCalendarRow | null>;
  events?: Record<string, SaleChangeEventSummary[]>;
  scope?: Record<string, { hasActiveAlert: boolean; departments: string[] }>;
  newSales?: { total: number; sales: NewSaleSummary[] };
  email?: string | null;
};

/** Magasin en mémoire, avec un vrai comportement de journal (une réservation par compte et semaine). */
function makeStore(setup: Setup = {}) {
  const journal = new Map<
    string,
    { id: string; status: "pending" | "sent" | "failed"; attempts: number }
  >();
  let counter = 0;
  const store = {
    listConsentingUsers: vi.fn(async () => setup.users ?? [{ userId: USER, weekday: 2 }]),
    filterAdminUserIds: vi.fn(
      async (ids: string[]) => new Set(ids.filter((id) => (setup.admins ?? []).includes(id))),
    ),
    usersEmailedSince: vi.fn(
      async (ids: string[], _since: Date) =>
        new Set(ids.filter((id) => (setup.emailedToday ?? []).includes(id))),
    ),
    // Comme la base : envoyé, ou trois essais épuisés ; plus les semaines imposées par le test.
    settledDigests: vi.fn(
      async (entries: Array<{ userId: string; weekKey: string }>) =>
        new Set(
          entries
            .map(({ userId, weekKey }) => `${userId}|${weekKey}`)
            .filter((key) => {
              const row = journal.get(key);
              return (
                (setup.settled ?? []).includes(key) ||
                (row !== undefined && (row.status === "sent" || row.attempts >= 3))
              );
            }),
        ),
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
    alertScope: vi.fn(
      async (userId: string) =>
        setup.scope?.[userId] ?? { hasActiveAlert: true, departments: ["33"] },
    ),
    newSalesIn: vi.fn(
      async (_departments: string[], _since: Date, _limit: number) =>
        setup.newSales ?? { total: 0, sales: [] },
    ),
    claim: vi.fn(
      async (args: { userId: string; weekKey: string; payload: Record<string, unknown> }) => {
        const key = `${args.userId}|${args.weekKey}`;
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
        const id = `digest-${counter}`;
        journal.set(key, { id, status: "pending", attempts: 1 });
        return id;
      },
    ),
    markSent: vi.fn(async (id: string) => {
      for (const row of journal.values()) if (row.id === id) row.status = "sent";
    }),
    markFailed: vi.fn(async (id: string, _args: { error: WeeklyDigestFailureCode }) => {
      for (const row of journal.values()) if (row.id === id) row.status = "failed";
    }),
    userEmail: vi.fn(async () =>
      setup.email === undefined ? "investisseur@example.test" : setup.email,
    ),
  } satisfies WeeklyDigestStore;
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
    journal?: ReturnType<typeof makeStore>;
    env?: Record<string, string>;
  } = {},
) {
  const made = options.journal ?? makeStore(setup);
  const fetchImpl = options.fetchImpl ?? resendOk();
  const summary = await runWeeklyDigest({
    store: made.store,
    now: options.now ?? TUESDAY,
    env: options.env ?? env,
    fetchImpl,
    mode: options.mode ?? "on",
  });
  return { ...made, fetchImpl, summary, emails: sentEmails(fetchImpl) };
}

describe("calendrier du récapitulatif", () => {
  it("donne le jour ISO et la semaine ISO d'un jour civil", () => {
    expect(isoWeekday("2026-11-03")).toBe(2);
    expect(isoWeekday("2026-11-08")).toBe(7);
    expect(isoWeekday("2026-11-09")).toBe(1);
    expect(isoWeekKey("2026-11-03")).toBe("2026-W45");
    expect(isoWeekKey("2026-11-08")).toBe("2026-W45");
    expect(isoWeekKey("2026-11-09")).toBe("2026-W46");
    // La semaine du 1er janvier 2026 (un jeudi) est la première de l'année ; 2026 compte 53 semaines.
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01");
    expect(isoWeekKey("2025-12-29")).toBe("2026-W01");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-04")).toBe("2027-W01");
  });

  it("est dû le jour choisi, puis les deux jours suivants pour un envoi reporté, pas avant ni après", () => {
    expect(MAX_DEFERRAL_DAYS).toBe(2);
    // Aujourd'hui mardi 3 novembre (semaine 45).
    expect(dueDigest(2, TUESDAY)).toEqual({ dueDay: "2026-11-03", weekKey: "2026-W45", lag: 0 });
    // Le lundi précédent est dû depuis un jour, le dimanche depuis deux, le samedi depuis trois : trop tard.
    expect(dueDigest(1, TUESDAY)).toEqual({ dueDay: "2026-11-02", weekKey: "2026-W45", lag: 1 });
    expect(dueDigest(7, TUESDAY)).toEqual({ dueDay: "2026-11-01", weekKey: "2026-W44", lag: 2 });
    expect(dueDigest(6, TUESDAY)).toBeNull();
    // Le jour choisi est demain : pas encore dû.
    expect(dueDigest(3, TUESDAY)).toBeNull();
  });

  it("garde la semaine du jour choisi pour un envoi reporté d'une semaine à l'autre", () => {
    // Dimanche 8 novembre choisi, aujourd'hui lundi 9 : la semaine du journal reste la 45.
    const monday = new Date("2026-11-09T10:30:00Z");
    expect(dueDigest(7, monday)).toEqual({ dueDay: "2026-11-08", weekKey: "2026-W45", lag: 1 });
  });

  it("compte le jour à Paris, pas en UTC", () => {
    // 23 h 30 UTC le lundi 2 novembre : il est déjà mardi 3 à Paris.
    const lateMonday = new Date("2026-11-02T23:30:00Z");
    expect(dueDigest(2, lateMonday)?.lag).toBe(0);
    expect(parisDayStart(TUESDAY).toISOString()).toBe("2026-11-02T23:00:00.000Z");
    // Heure d'été : le 20 juillet, minuit à Paris est 22 h UTC la veille.
    expect(parisDayStart(new Date("2026-07-20T09:00:00Z")).toISOString()).toBe(
      "2026-07-19T22:00:00.000Z",
    );
  });
});

describe("upcomingAudienceFor", () => {
  it("annonce une date sourcée dans la fenêtre, avec l'heure si elle est connue", () => {
    const upcoming = upcomingAudienceFor(calendarRow(SALE), TUESDAY);
    expect(upcoming?.item).toMatchObject({
      saleId: SALE,
      title: "Maison à Bordeaux",
      location: "Tribunal judiciaire de Bordeaux",
      detail: "Audience : mardi 10 novembre 2026 à 14 h 00",
    });
    const dateOnly = upcomingAudienceFor(calendarRow(SALE, { date_only: true }), TUESDAY);
    expect(dateOnly?.item.detail).toBe("Audience : mardi 10 novembre 2026");
  });

  it("n'annonce ni une date non sourcée, ni une date passée, ni une date trop lointaine", () => {
    expect(upcomingAudienceFor(calendarRow(SALE, { exportable: false }), TUESDAY)).toBeNull();
    expect(upcomingAudienceFor(calendarRow(SALE, { sale_date: null }), TUESDAY)).toBeNull();
    expect(
      upcomingAudienceFor(calendarRow(SALE, { sale_date: "2026-11-02T13:00:00Z" }), TUESDAY),
    ).toBeNull();
    expect(AUDIENCE_WINDOW_DAYS).toBe(14);
    expect(
      upcomingAudienceFor(calendarRow(SALE, { sale_date: "2026-11-17T13:00:00Z" }), TUESDAY),
    ).not.toBeNull();
    expect(
      upcomingAudienceFor(calendarRow(SALE, { sale_date: "2026-11-18T13:00:00Z" }), TUESDAY),
    ).toBeNull();
  });
});

describe("buildDigestContent", () => {
  it("réunit les trois rubriques : audiences, changements sans montant ni date, nouvelles ventes", async () => {
    const { store } = makeStore({
      followed: {
        [USER]: [
          { id: SALE, saleDate: "2026-11-10T13:00:00Z" },
          { id: SALE_2, saleDate: "2026-12-30T13:00:00Z" },
        ],
      },
      events: {
        [USER]: [
          change(),
          change({
            id: "event-2",
            saleId: SALE_2,
            eventKind: "audience_changed",
            fingerprint: "audience",
            changeSummary: {
              field: "saleDate",
              previousValue: "2026-12-01T10:00:00Z",
              currentValue: "2026-12-30T13:00:00Z",
            },
          }),
        ],
      },
      newSales: {
        total: 7,
        sales: [{ id: "n1", propertyType: "apartment", city: "Mérignac", department: "33" }],
      },
    });
    const content = await buildDigestContent({ store, userId: USER, now: TUESDAY });
    expect(content.audiences).toHaveLength(1);
    expect(content.audiences[0].saleId).toBe(SALE);
    // Les valeurs (montants, dates) ne sont jamais recopiées : seulement le libellé.
    expect(content.changes.map((item) => [item.label, item.detail])).toEqual([
      ["Mise à prix abaissée", "Montants à confirmer."],
      ["Date de la vente modifiée", "Dates à confirmer."],
    ]);
    expect(JSON.stringify(content)).not.toMatch(/120 ?000|100 ?000|€/);
    expect(content.newSales).toMatchObject({ departments: ["33"], total: 7 });
    expect(content.newSales.items[0]).toMatchObject({
      saleId: "n1",
      title: "Appartement à Mérignac",
      location: "Département 33",
    });
    expect(content.hasAlert).toBe(true);
    expect(store.newSalesIn).toHaveBeenCalledWith(
      ["33"],
      new Date("2026-10-27T10:30:00Z"),
      MAX_NEW_SALES,
    );
  });

  it("n'annonce que les dates sourcées et revérifiées à la source depuis moins de 36 h", async () => {
    const stats = { skippedStale: 0 };
    const stale = makeStore({ verified: { [SALE]: "2026-10-30T00:00:00Z" } });
    expect(
      (await buildDigestContent({ store: stale.store, userId: USER, now: TUESDAY, stats }))
        .audiences,
    ).toEqual([]);
    expect(stats.skippedStale).toBe(1);

    const unknown = makeStore({ verified: { [SALE]: null } });
    expect(
      (await buildDigestContent({ store: unknown.store, userId: USER, now: TUESDAY })).audiences,
    ).toEqual([]);

    const unsourced = makeStore({ calendar: { [SALE]: calendarRow(SALE, { exportable: false }) } });
    expect(
      (await buildDigestContent({ store: unsourced.store, userId: USER, now: TUESDAY })).audiences,
    ).toEqual([]);
  });

  it("ignore les ventes hors de la fenêtre de 14 jours, sans lire leur date publique", async () => {
    const { store } = makeStore({
      followed: { [USER]: [{ id: SALE, saleDate: "2027-03-01T10:00:00Z" }] },
    });
    const content = await buildDigestContent({ store, userId: USER, now: TUESDAY });
    expect(content.audiences).toEqual([]);
    expect(store.calendarEvent).not.toHaveBeenCalled();
  });

  it("ne lit ni n'annonce une vente qui n'est pas publiquement visible", async () => {
    const { store } = makeStore({ hidden: [SALE], events: { [USER]: [change()] } });
    const content = await buildDigestContent({ store, userId: USER, now: TUESDAY });
    expect(content.audiences).toEqual([]);
    expect(content.changes).toEqual([]);
    expect(store.recentChangeEvents).not.toHaveBeenCalled();
  });

  it("ne reprend pas un changement masqué, plus ancien que 7 jours ou sur une vente non suivie", async () => {
    const { store } = makeStore({
      events: {
        [USER]: [
          change({ id: "masque", dismissedAt: "2026-11-02T00:00:00Z", fingerprint: "a" }),
          change({ id: "ancien", detectedAt: "2026-10-20T00:00:00Z", fingerprint: "b" }),
          change({ id: "autre", saleId: SALE_2, fingerprint: "c" }),
          // Un score qui bouge n'est jamais montré.
          change({ id: "score", eventKind: "score_changed", fingerprint: "d" }),
        ],
      },
    });
    expect((await buildDigestContent({ store, userId: USER, now: TUESDAY })).changes).toEqual([]);
  });

  it("limite chaque rubrique et compte le reste", async () => {
    const sales: FollowedSale[] = Array.from({ length: MAX_AUDIENCES + 3 }, (_, index) => ({
      id: `22222222-0000-4000-8000-${String(index).padStart(12, "0")}`,
      saleDate: "2026-11-10T13:00:00Z",
    }));
    const events = sales.map((sale, index) =>
      change({ id: `e${index}`, saleId: sale.id, fingerprint: `f${index}` }),
    );
    const { store } = makeStore({ followed: { [USER]: sales }, events: { [USER]: events } });
    const content = await buildDigestContent({ store, userId: USER, now: TUESDAY });
    expect(content.audiences).toHaveLength(MAX_AUDIENCES);
    expect(content.audiencesMore).toBe(3);
    expect(content.changes).toHaveLength(MAX_CHANGES);
    expect(content.changesMore).toBe(3);
  });

  it("sans alerte : pas de nouvelles ventes et le bouton « Créer une alerte » à proposer", async () => {
    const { store } = makeStore({
      scope: { [USER]: { hasActiveAlert: false, departments: [] } },
    });
    const content = await buildDigestContent({ store, userId: USER, now: TUESDAY });
    expect(content.hasAlert).toBe(false);
    expect(content.newSales.items).toEqual([]);
    expect(store.newSalesIn).not.toHaveBeenCalled();
  });

  it("limite à trois départements d'alertes et ne les répète pas", async () => {
    const { store } = makeStore({
      scope: {
        [USER]: { hasActiveAlert: true, departments: ["33", "33", "75", "69", "13"] },
      },
    });
    await buildDigestContent({ store, userId: USER, now: TUESDAY });
    expect(store.newSalesIn.mock.calls[0][0]).toEqual(["33", "75", "69"]);
  });
});

describe("runWeeklyDigest : modes d'envoi", () => {
  it("n'envoie rien, ne lit rien et n'écrit rien en mode off", async () => {
    const { store, fetchImpl, summary } = await run({}, { mode: "off" });
    expect(summary.skipped).toBe("off");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.listConsentingUsers).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(() => assertWeeklyDigestComplete(summary)).not.toThrow();
  });

  it("lit le mode dans WEEKLY_DIGEST_MODE quand il n'est pas imposé : off sans variable", async () => {
    const made = makeStore();
    const fetchImpl = resendOk();
    const off = await runWeeklyDigest({ store: made.store, now: TUESDAY, env, fetchImpl });
    expect(off.skipped).toBe("off");
    // Ni SALE_REMINDERS_MODE ni SALE_RESULTS_MODE n'ouvrent le récapitulatif.
    const stillOff = await runWeeklyDigest({
      store: made.store,
      now: TUESDAY,
      env: { ...env, SALE_REMINDERS_MODE: "on", SALE_RESULTS_MODE: "on" },
      fetchImpl,
    });
    expect(stillOff.skipped).toBe("off");
    const on = await runWeeklyDigest({
      store: made.store,
      now: TUESDAY,
      env: { ...env, WEEKLY_DIGEST_MODE: "on" },
      fetchImpl,
    });
    expect(on.emailsSent).toBe(1);
  });

  it("n'écrit qu'aux administrateurs ayant consenti en mode internal, objet préfixé", async () => {
    const { emails, summary, store } = await run(
      {
        users: [
          { userId: USER, weekday: 2 },
          { userId: OTHER, weekday: 2 },
        ],
        admins: [OTHER],
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
    const { emails, summary } = await run({
      users: [
        { userId: USER, weekday: 2 },
        { userId: OTHER, weekday: 2 },
      ],
    });
    expect(summary.recipients).toBe(2);
    expect(emails).toHaveLength(2);
    expect(emails[0].subject.startsWith("[Test interne]")).toBe(false);
  });

  it("ne lit personne quand personne n'a consenti", async () => {
    const { emails, store } = await run({ users: [] });
    expect(emails).toHaveLength(0);
    expect(store.followedSales).not.toHaveBeenCalled();
  });
});

describe("runWeeklyDigest : un email par semaine, au jour choisi", () => {
  it("envoie un seul email le jour choisi, avec les trois rubriques", async () => {
    const { emails, summary, store } = await run({
      newSales: {
        total: 2,
        sales: [{ id: "n1", propertyType: "house", city: "Pessac", department: "33" }],
      },
    });
    expect(summary).toMatchObject({ due: 1, emailsSent: 1, emailsFailed: 0, truncated: false });
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toEqual(["investisseur@example.test"]);
    expect(emails[0].subject).toBe("Ma semaine sur Immojudis : 1 audience, 2 nouvelles ventes");
    expect(store.claim).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, weekKey: "2026-W45", mode: "on" }),
    );
    // Le journal ne garde que des compteurs.
    expect(store.claim.mock.calls[0][0].payload).toEqual({
      audiences: 1,
      changes: 0,
      newSales: 2,
      hasAlert: true,
    });
    expect(store.markSent).toHaveBeenCalledWith("digest-1", expect.anything());
    expect(() => assertWeeklyDigestComplete(summary)).not.toThrow();
  });

  it("n'envoie rien un autre jour que celui choisi", async () => {
    const { emails, summary, store } = await run({ users: [{ userId: USER, weekday: 4 }] });
    expect(summary.due).toBe(0);
    expect(emails).toHaveLength(0);
    expect(store.followedSales).not.toHaveBeenCalled();
  });

  it("n'envoie qu'un récapitulatif par semaine, même si le passage est relancé", async () => {
    const first = await run({});
    expect(first.emails).toHaveLength(1);
    // Même jour, même journal : la semaine est servie, rien n'est relu ni renvoyé.
    const second = await run({}, { journal: first });
    expect(second.summary.due).toBe(0);
    expect(second.emails).toHaveLength(0);
    // Le lendemain (envoi reporté possible), le récapitulatif de la semaine est déjà là.
    const next = await run({}, { now: new Date("2026-11-04T10:30:00Z"), journal: first });
    expect(next.summary.due).toBe(0);
    expect(next.emails).toHaveLength(0);
  });

  it("ne renvoie pas un récapitulatif qu'un autre passage vient de réserver", async () => {
    const made = makeStore();
    // Un passage concurrent a réservé la semaine sans l'avoir encore envoyée.
    await made.store.claim({ userId: USER, weekKey: "2026-W45", payload: {} });
    const { emails, summary } = await run({}, { journal: made });
    expect(summary.due).toBe(1);
    expect(summary.alreadyClaimed).toBe(1);
    expect(emails).toHaveLength(0);
  });

  it("ne relit pas le contenu d'une semaine déjà servie", async () => {
    const { store, summary } = await run({ settled: [`${USER}|2026-W45`] });
    expect(summary.due).toBe(0);
    expect(store.followedSales).not.toHaveBeenCalled();
    expect(store.usersEmailedSince).not.toHaveBeenCalled();
  });

  it("n'écrit pas quand il n'y a rien à annoncer : ni audience, ni changement, ni nouvelle vente", async () => {
    const { emails, summary, store } = await run({
      followed: { [USER]: [] },
      scope: { [USER]: { hasActiveAlert: true, departments: ["33"] } },
    });
    expect(emails).toHaveLength(0);
    expect(summary.skippedEmpty).toBe(1);
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("n'écrit pas non plus à un compte sans alerte ni audience ni changement (le bouton seul ne justifie pas l'email)", async () => {
    const { emails, summary } = await run({
      followed: { [USER]: [] },
      scope: { [USER]: { hasActiveAlert: false, departments: [] } },
    });
    expect(emails).toHaveLength(0);
    expect(summary.skippedEmpty).toBe(1);
  });

  it("propose le bouton « Créer une alerte » à un compte sans alerte qui a des audiences", async () => {
    const { emails } = await run({ scope: { [USER]: { hasActiveAlert: false, departments: [] } } });
    expect(emails).toHaveLength(1);
    expect(emails[0].text).toContain("Créer une alerte : https://immojudis.com/alertes");
    expect(emails[0].html).toContain("Créer une alerte");
  });
});

describe("runWeeklyDigest : au plus un email par compte et par jour", () => {
  it("reporte le récapitulatif quand un autre email est déjà parti aujourd'hui au compte", async () => {
    const { emails, summary, store } = await run({ emailedToday: [USER] });
    expect(emails).toHaveLength(0);
    expect(summary).toMatchObject({ due: 1, deferredSameDay: 1, emailsSent: 0 });
    // Rien n'est réservé ni relu : le récapitulatif reste dû pour demain.
    expect(store.claim).not.toHaveBeenCalled();
    expect(store.followedSales).not.toHaveBeenCalled();
    expect(store.usersEmailedSince).toHaveBeenCalledWith([USER], new Date("2026-11-02T23:00:00Z"));
    expect(() => assertWeeklyDigestComplete(summary)).not.toThrow();
  });

  it("l'envoie le lendemain, avec la semaine du jour choisi, une fois libre", async () => {
    const setup: Setup = { emailedToday: [USER] };
    const made = makeStore(setup);
    // Mardi (jour choisi) : un autre email est déjà parti, le récapitulatif est reporté.
    const tuesday = await run(setup, { journal: made });
    expect(tuesday.emails).toHaveLength(0);
    expect(tuesday.summary.deferredSameDay).toBe(1);
    // Mercredi (report d'un jour) : plus rien d'autre n'est parti, il part, dans la semaine 45.
    setup.emailedToday = [];
    const wednesday = await run(setup, {
      journal: made,
      now: new Date("2026-11-04T10:30:00Z"),
    });
    expect(wednesday.emails).toHaveLength(1);
    expect(made.store.claim.mock.calls[0][0].weekKey).toBe("2026-W45");
    // Jeudi : la semaine est servie, rien ne repart.
    const thursday = await run(setup, { journal: made, now: new Date("2026-11-05T10:30:00Z") });
    expect(thursday.summary.due).toBe(0);
    expect(thursday.emails).toHaveLength(0);
  });

  it("saute la semaine quand un autre email part encore au compte jusqu'au dernier jour de report", async () => {
    const setup: Setup = { emailedToday: [USER] };
    const made = makeStore(setup);
    for (const day of ["2026-11-03", "2026-11-04", "2026-11-05"]) {
      const result = await run(setup, { journal: made, now: new Date(`${day}T10:30:00Z`) });
      expect(result.emails, day).toHaveLength(0);
      expect(result.summary.deferredSameDay, day).toBe(1);
    }
    // Vendredi : plus dû, la semaine est sautée.
    const friday = await run(setup, { journal: made, now: new Date("2026-11-06T10:30:00Z") });
    expect(friday.summary.due).toBe(0);
    expect(friday.emails).toHaveLength(0);
  });

  it("ne reporte que le compte concerné", async () => {
    const { emails, summary } = await run({
      users: [
        { userId: USER, weekday: 2 },
        { userId: OTHER, weekday: 2 },
      ],
      emailedToday: [USER],
    });
    expect(summary.deferredSameDay).toBe(1);
    expect(emails).toHaveLength(1);
  });
});

describe("runWeeklyDigest : échecs", () => {
  it("échoue quand un envoi est dû et que Resend n'est pas configuré, en nommant les variables", async () => {
    const { summary, fetchImpl, store } = await run({}, { env: {} });
    expect(summary).toMatchObject({ configured: false, due: 1, emailsSent: 0 });
    expect(summary.missingConfig).toEqual(["RESEND_API_KEY", "ALERT_EMAIL_FROM", "SITE_URL"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(() => assertWeeklyDigestComplete(summary)).toThrow(
      /1 envoi\(s\) dû\(s\) mais l'envoi d'e-mails n'est pas configuré.*RESEND_API_KEY/,
    );
  });

  it("réussit sans rien envoyer quand rien n'est dû, même sans Resend", async () => {
    const { summary } = await run({ users: [{ userId: USER, weekday: 4 }] }, { env: {} });
    expect(summary.due).toBe(0);
    expect(() => assertWeeklyDigestComplete(summary)).not.toThrow();
  });

  it("garde un code court au journal quand Resend refuse, et fait échouer le passage", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "adresse x@y.z refusée" }), { status: 422 }),
    ) as unknown as ReturnType<typeof resendOk>;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store, summary } = await run({}, { fetchImpl });
    expect(summary.emailsFailed).toBe(1);
    expect(store.markFailed).toHaveBeenCalledWith("digest-1", { error: "send_failed" });
    expect(JSON.stringify(store.markFailed.mock.calls)).not.toContain("x@y.z");
    expect(() => assertWeeklyDigestComplete(summary)).toThrow(/1 envoi\(s\) en échec/);
    spy.mockRestore();
  });

  it("reprend un envoi en échec le lendemain, trois essais au plus", async () => {
    const failing = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as ReturnType<
      typeof resendOk
    >;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = await run({}, { fetchImpl: failing });
    expect(first.summary.emailsFailed).toBe(1);
    const retry = await run({}, { journal: first, now: new Date("2026-11-04T10:30:00Z") });
    expect(retry.emails).toHaveLength(1);
    expect(retry.summary.emailsSent).toBe(1);
    spy.mockRestore();
  });

  it("note une adresse absente ou non confirmée comme un échec, sans rien envoyer", async () => {
    const { store, summary, fetchImpl } = await run({ email: null });
    expect(store.markFailed).toHaveBeenCalledWith("digest-1", { error: "email_unavailable" });
    expect(summary.emailsFailed).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("note une lecture d'adresse en échec", async () => {
    const made = makeStore();
    made.store.userEmail.mockRejectedValueOnce(new Error("auth indisponible"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store } = await run({}, { journal: made });
    expect(store.markFailed).toHaveBeenCalledWith("digest-1", { error: "email_lookup_failed" });
    spy.mockRestore();
  });

  it("fait échouer le passage quand une lecture échoue, plutôt que de conclure à l'absence de contenu", async () => {
    const made = makeStore();
    made.store.followedSales.mockRejectedValueOnce(new Error("base injoignable"));
    await expect(run({}, { journal: made })).rejects.toThrow("base injoignable");
  });

  it("assertWeeklyDigestComplete signale un passage interrompu par le délai", () => {
    const summary = {
      skipped: null,
      configured: true,
      due: 3,
      truncated: true,
      emailsFailed: 0,
      emailsSent: 1,
    } as WeeklyDigestRunSummary;
    expect(() => assertWeeklyDigestComplete(summary)).toThrow(/interrompu par le délai/);
  });
});
