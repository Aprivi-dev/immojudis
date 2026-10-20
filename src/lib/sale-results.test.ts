import { describe, expect, it, vi } from "vitest";
import type { SaleCalendarRow } from "@/lib/sale-calendar";
import type { SaleChangeEventSummary } from "@/lib/sale-change-monitor";
import type { FollowedSale } from "@/lib/sale-reminders";
import {
  MAX_RESULT_ITEMS_PER_EMAIL,
  assertSaleResultsComplete,
  detectSaleResultsForUser,
  runSaleResults,
  saleResultKindFor,
  type FollowedSnapshot,
  type SaleResultFailureCode,
  type SaleResultStore,
} from "@/lib/sale-results";

// Mercredi 4 novembre 2026, 11 h 15 à Paris.
const NOW = new Date("2026-11-04T10:15:00Z");
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
    exportable: false,
    sale_date: null,
    date_only: false,
    property_type: "house",
    city: "Bordeaux",
    tribunal_name: "TJ Bordeaux",
    tribunal_city: "Bordeaux",
    updated_at: "2026-11-01T00:00:00Z",
    ...overrides,
  };
}

function statusEvent(
  current: string,
  previous = "upcoming",
  overrides: Partial<SaleChangeEventSummary> = {},
): SaleChangeEventSummary {
  return {
    id: `event-${previous}-${current}`,
    saleId: SALE,
    watchKind: "favorite",
    watchId: "watch-1",
    eventKind: "status_changed",
    severity: "urgent",
    fingerprint: `status_changed:status:${previous}:${current}`,
    summaryLabel: "Statut de la vente modifié",
    changeSummary: { field: "status", previousValue: previous, currentValue: current },
    detectedAt: "2026-11-04T05:00:00.000Z",
    readAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<FollowedSnapshot> = {}): FollowedSnapshot {
  return {
    saleId: SALE,
    capturedAt: "2026-11-03T14:00:00Z",
    resultStatus: "adjudicated",
    saleDate: "2026-11-03T13:00:00Z",
    venueType: "tribunal",
    city: "Bordeaux",
    propertyType: "house",
    tribunalName: "TJ Bordeaux",
    ...overrides,
  };
}

type Setup = {
  consenting?: string[];
  admins?: string[];
  snapshots?: Record<string, FollowedSnapshot[]>;
  followed?: Record<string, FollowedSale[]>;
  hidden?: string[];
  events?: Record<string, SaleChangeEventSummary[]>;
  /** Avertissements déjà annoncés par les rappels : `compte|vente|statut`. */
  reminded?: string[];
  email?: string | null;
};

function makeStore(setup: Setup = {}) {
  const journal = new Map<
    string,
    { id: string; status: "pending" | "sent" | "failed"; attempts: number }
  >();
  let counter = 0;
  const store = {
    listConsentingUserIds: vi.fn(async () => setup.consenting ?? [USER]),
    filterAdminUserIds: vi.fn(
      async (ids: string[]) => new Set(ids.filter((id) => (setup.admins ?? []).includes(id))),
    ),
    followedSales: vi.fn(
      async (userId: string) => setup.followed?.[userId] ?? [{ id: SALE, saleDate: null }],
    ),
    visibleSaleIds: vi.fn(
      async (ids: string[]) => new Set(ids.filter((id) => !(setup.hidden ?? []).includes(id))),
    ),
    calendarEvent: vi.fn(async (saleId: string) => calendarRow(saleId)),
    recentChangeEvents: vi.fn(async (userId: string) => setup.events?.[userId] ?? []),
    recentSnapshots: vi.fn(async (userId: string) => setup.snapshots?.[userId] ?? []),
    reminderWarningExists: vi.fn(async (userId: string, saleId: string, status: string) =>
      (setup.reminded ?? []).includes(`${userId}|${saleId}|${status}`),
    ),
    claim: vi.fn(
      async (args: { userId: string; saleId: string; kind: string; payload: unknown }) => {
        const key = `${args.userId}|${args.saleId}|${args.kind}`;
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
        const id = `result-${counter}`;
        journal.set(key, { id, status: "pending", attempts: 1 });
        return id;
      },
    ),
    markSent: vi.fn(async (ids: string[]) => {
      for (const row of journal.values()) if (ids.includes(row.id)) row.status = "sent";
    }),
    markFailed: vi.fn(async (ids: string[], _args: { error: SaleResultFailureCode }) => {
      for (const row of journal.values()) if (ids.includes(row.id)) row.status = "failed";
    }),
    userEmail: vi.fn(async () =>
      setup.email === undefined ? "investisseur@example.test" : setup.email,
    ),
  } satisfies SaleResultStore;
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
    journal?: ReturnType<typeof makeStore>;
    env?: Record<string, string>;
  } = {},
) {
  const made = options.journal ?? makeStore(setup);
  const fetchImpl = options.fetchImpl ?? resendOk();
  const summary = await runSaleResults({
    store: made.store,
    now: NOW,
    env: options.env ?? env,
    fetchImpl,
    mode: options.mode ?? "on",
  });
  return { ...made, fetchImpl, summary, emails: sentEmails(fetchImpl) };
}

describe("saleResultKindFor", () => {
  it("classe les changements de statut qui comptent", () => {
    expect(saleResultKindFor(statusEvent("adjudicated"))).toEqual({
      kind: "result_known",
      status: "adjudicated",
    });
    expect(saleResultKindFor(statusEvent("withdrawn"))?.kind).toBe("withdrawn");
    expect(saleResultKindFor(statusEvent("cancelled"))?.kind).toBe("withdrawn");
    expect(saleResultKindFor(statusEvent("Canceled"))?.kind).toBe("withdrawn");
    for (const previous of ["past", "adjudicated", "withdrawn", "cancelled"]) {
      expect(saleResultKindFor(statusEvent("upcoming", previous))?.kind, previous).toBe("relisted");
    }
  });

  it("ne tient pas un report suivi d'une nouvelle date pour une remise en vente", () => {
    expect(saleResultKindFor(statusEvent("upcoming", "postponed"))).toBeNull();
    expect(saleResultKindFor(statusEvent("upcoming", "upcoming"))).toBeNull();
    expect(saleResultKindFor(statusEvent("upcoming", ""))).toBeNull();
  });

  it("ignore les autres statuts et les autres types d'événement", () => {
    expect(saleResultKindFor(statusEvent("postponed"))).toBeNull();
    expect(saleResultKindFor(statusEvent("past"))).toBeNull();
    expect(saleResultKindFor(statusEvent("quelque chose"))).toBeNull();
    expect(
      saleResultKindFor(statusEvent("adjudicated", "upcoming", { eventKind: "price_changed" })),
    ).toBeNull();
    expect(
      saleResultKindFor(
        statusEvent("adjudicated", "upcoming", { changeSummary: { currentValue: 5 } }),
      ),
    ).toBeNull();
  });
});

describe("detectSaleResultsForUser", () => {
  it("annonce un instantané adjugé comme « résultat connu », avec la fenêtre de surenchère, vers Mes favoris", async () => {
    const { store } = makeStore({ snapshots: { [USER]: [snapshot()] } });
    const [result] = await detectSaleResultsForUser({ store, userId: USER, now: NOW });
    expect(result.kind).toBe("result_known");
    expect(result.item).toMatchObject({
      title: "Maison à Bordeaux",
      link: "favorites",
      headline: "La vente que vous suivez a eu lieu : un résultat est connu",
    });
    expect(result.item.surenchere).toMatchObject({
      kind: "window",
      deadline: "2026-11-13",
      adjudicationConfirmed: true,
    });
    expect(result.payload).toEqual({ origin: "snapshot", result: "adjudicated" });
  });

  it("annonce un instantané sans résultat comme « résultat non connu », jamais comme « non adjugée »", async () => {
    const { store } = makeStore({
      snapshots: { [USER]: [snapshot({ resultStatus: "unknown" })] },
    });
    const [result] = await detectSaleResultsForUser({ store, userId: USER, now: NOW });
    expect(result.kind).toBe("result_unknown");
    expect(result.item.headline).toBe("La vente que vous suivez a eu lieu : résultat non connu");
    expect(result.item.surenchere).toMatchObject({ adjudicationConfirmed: false });
    expect(JSON.stringify(result)).not.toMatch(/non adjug/i);
  });

  it("annonce un statut grave du suivi, avec le titre public et un lien vers la fiche", async () => {
    const { store } = makeStore({
      events: {
        [USER]: [
          statusEvent("withdrawn"),
          statusEvent("upcoming", "withdrawn", { saleId: SALE_2, fingerprint: "relist" }),
        ],
      },
      followed: {
        [USER]: [
          { id: SALE, saleDate: null },
          { id: SALE_2, saleDate: null },
        ],
      },
    });
    const results = await detectSaleResultsForUser({ store, userId: USER, now: NOW });
    expect(results.map((result) => [result.saleId, result.kind])).toEqual([
      [SALE_2, "relisted"],
      [SALE, "withdrawn"],
    ]);
    expect(results[1].item).toMatchObject({ link: "sale", surenchere: null });
    expect(results[1].payload).toEqual({ origin: "status_event", status: "withdrawn" });
  });

  it("n'annonce pas comme retirée une vente retirée par absence de l'annonce à la source", async () => {
    const { store } = makeStore({
      events: {
        [USER]: [
          statusEvent("withdrawn", "upcoming", {
            severity: "important",
            changeSummary: {
              field: "status",
              previousValue: "upcoming",
              currentValue: "withdrawn",
              reason: "source_absence",
            },
          }),
        ],
      },
      followed: { [USER]: [{ id: SALE, saleDate: null }] },
    });
    const [result] = await detectSaleResultsForUser({ store, userId: USER, now: NOW });
    expect(result.kind).toBe("withdrawn");
    expect(result.item.headline).toBe("La vente que vous suivez : annonce disparue de la source");
    expect(result.item.detail).toBe("À vérifier auprès de l’avocat poursuivant.");
    expect(`${result.item.headline} ${result.item.detail}`).not.toMatch(/retir|annul/i);
    expect(result.payload).toEqual({
      origin: "status_event",
      status: "withdrawn",
      reason: "source_absence",
    });
  });

  it("n'annonce pas deux fois la même vente et le même type, instantané ou changement de statut", async () => {
    const { store } = makeStore({
      snapshots: { [USER]: [snapshot()] },
      events: { [USER]: [statusEvent("adjudicated")] },
    });
    const results = await detectSaleResultsForUser({ store, userId: USER, now: NOW });
    expect(results).toHaveLength(1);
    expect(results[0].item.link).toBe("favorites");
  });

  it("ne répète pas un avertissement que les rappels d'audience ont déjà annoncé", async () => {
    const stats = { skippedCovered: 0 };
    const { store } = makeStore({
      snapshots: { [USER]: [snapshot()] },
      events: { [USER]: [statusEvent("withdrawn")] },
      reminded: [`${USER}|${SALE}|adjudicated`, `${USER}|${SALE}|withdrawn`],
    });
    expect(await detectSaleResultsForUser({ store, userId: USER, now: NOW, stats })).toEqual([]);
    expect(stats.skippedCovered).toBe(2);
  });

  it("annonce une remise en vente même quand les rappels ont annoncé l'ancien statut", async () => {
    const { store } = makeStore({
      events: { [USER]: [statusEvent("upcoming", "withdrawn")] },
      reminded: [`${USER}|${SALE}|withdrawn`, `${USER}|${SALE}|upcoming`],
    });
    const results = await detectSaleResultsForUser({ store, userId: USER, now: NOW });
    expect(results.map((result) => result.kind)).toEqual(["relisted"]);
  });

  it("ne lit pas les événements d'une vente qui n'est pas publiquement visible", async () => {
    const { store } = makeStore({ hidden: [SALE], events: { [USER]: [statusEvent("withdrawn")] } });
    expect(await detectSaleResultsForUser({ store, userId: USER, now: NOW })).toEqual([]);
    expect(store.recentChangeEvents).not.toHaveBeenCalled();
  });

  it("ne lit les instantanés que sur les 7 derniers jours", async () => {
    const { store } = makeStore();
    await detectSaleResultsForUser({ store, userId: USER, now: NOW });
    expect(store.recentSnapshots).toHaveBeenCalledWith(USER, new Date("2026-10-28T10:15:00Z"));
    expect(store.recentChangeEvents).toHaveBeenCalledWith(
      USER,
      [SALE],
      new Date("2026-11-01T10:15:00Z"),
    );
  });
});

describe("runSaleResults : modes d'envoi", () => {
  it("n'envoie rien, ne lit rien et n'écrit rien en mode off", async () => {
    const { store, fetchImpl, summary } = await run({}, { mode: "off" });
    expect(summary.skipped).toBe("off");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.listConsentingUserIds).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(() => assertSaleResultsComplete(summary)).not.toThrow();
  });

  it("lit le mode dans SALE_RESULTS_MODE : off sans variable, jamais ouvert par les autres interrupteurs", async () => {
    const made = makeStore({ snapshots: { [USER]: [snapshot()] } });
    const fetchImpl = resendOk();
    const closed = await runSaleResults({
      store: made.store,
      now: NOW,
      env: { ...env, SALE_REMINDERS_MODE: "on", WEEKLY_DIGEST_MODE: "on" },
      fetchImpl,
    });
    expect(closed.skipped).toBe("off");
    const open = await runSaleResults({
      store: made.store,
      now: NOW,
      env: { ...env, SALE_RESULTS_MODE: "on" },
      fetchImpl,
    });
    expect(open.emailsSent).toBe(1);
  });

  it("n'écrit qu'aux administrateurs ayant consenti en mode internal, objet préfixé", async () => {
    const { emails, summary, store } = await run(
      {
        consenting: [USER, OTHER],
        admins: [OTHER],
        snapshots: { [USER]: [snapshot()], [OTHER]: [snapshot()] },
        email: "admin@example.test",
      },
      { mode: "internal" },
    );
    expect(summary.recipients).toBe(1);
    expect(emails).toHaveLength(1);
    expect(emails[0].subject.startsWith("[Test interne] ")).toBe(true);
    expect(store.recentSnapshots).toHaveBeenCalledTimes(1);
    expect(store.recentSnapshots).toHaveBeenCalledWith(OTHER, expect.any(Date));
  });

  it("n'écrit à personne sans consentement", async () => {
    const { emails, store } = await run({ consenting: [] });
    expect(emails).toHaveLength(0);
    expect(store.recentSnapshots).not.toHaveBeenCalled();
  });
});

describe("runSaleResults : envoi", () => {
  it("envoie un email par personne, sans prix, avec les liens et la désinscription", async () => {
    const { emails, summary, store } = await run({
      snapshots: { [USER]: [snapshot(), snapshot({ saleId: SALE_2, resultStatus: "unknown" })] },
    });
    expect(summary).toMatchObject({
      candidates: 2,
      claimed: 2,
      emailsSent: 1,
      emailsFailed: 0,
      sentByKind: { result_known: 1, result_unknown: 1, relisted: 0, withdrawn: 0 },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe("Vos ventes suivies : 2 résultats et mises à jour");
    const body = `${emails[0].subject}\n${emails[0].text}\n${emails[0].html}`;
    expect(body).not.toMatch(/€|euros?\b/i);
    expect(emails[0].text).toContain("https://immojudis.com/favoris");
    expect(emails[0].text).toContain("api/notification-preferences/unsubscribe?token=");
    expect(store.claim.mock.calls[0][0]).toMatchObject({
      userId: USER,
      saleId: SALE,
      kind: "result_known",
      mode: "on",
    });
    // Le journal ne garde ni prix ni contenu : l'origine et le résultat.
    expect(JSON.stringify(store.claim.mock.calls.map(([args]) => args.payload))).not.toMatch(
      /€|price|prix/i,
    );
    expect(() => assertSaleResultsComplete(summary)).not.toThrow();
  });

  it("n'envoie jamais deux fois la même alerte, même si le passage est relancé", async () => {
    const first = await run({ snapshots: { [USER]: [snapshot()] } });
    expect(first.emails).toHaveLength(1);
    const second = await run({}, { journal: first });
    expect(second.emails).toHaveLength(0);
    expect(second.summary).toMatchObject({ candidates: 1, claimed: 0, emailsSent: 0 });
  });

  it("limite un email à MAX_RESULT_ITEMS_PER_EMAIL éléments et compte le reste", async () => {
    const many = Array.from({ length: MAX_RESULT_ITEMS_PER_EMAIL + 2 }, (_, index) =>
      snapshot({ saleId: `33333333-0000-4000-8000-${String(index).padStart(12, "0")}` }),
    );
    const { emails, summary } = await run({ snapshots: { [USER]: many } });
    expect(emails).toHaveLength(1);
    expect(summary.claimed).toBe(MAX_RESULT_ITEMS_PER_EMAIL);
    expect(summary.deferred).toBe(2);
    // Le reste part au passage suivant : le passage ne doit pas échouer pour autant.
    expect(() => assertSaleResultsComplete(summary)).not.toThrow();
  });

  it("garde un code court au journal quand Resend refuse, et fait échouer le passage", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "adresse x@y.z refusée" }), { status: 422 }),
    ) as unknown as ReturnType<typeof resendOk>;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { store, summary } = await run({ snapshots: { [USER]: [snapshot()] } }, { fetchImpl });
    expect(summary.emailsFailed).toBe(1);
    expect(store.markFailed).toHaveBeenCalledWith(["result-1"], { error: "send_failed" });
    expect(JSON.stringify(store.markFailed.mock.calls)).not.toContain("x@y.z");
    expect(() => assertSaleResultsComplete(summary)).toThrow(/1 envoi\(s\) en échec/);
    spy.mockRestore();
  });

  it("reprend un envoi en échec au passage suivant", async () => {
    const failing = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as ReturnType<
      typeof resendOk
    >;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = await run({ snapshots: { [USER]: [snapshot()] } }, { fetchImpl: failing });
    expect(first.summary.emailsFailed).toBe(1);
    const retry = await run({}, { journal: first });
    expect(retry.summary.emailsSent).toBe(1);
    spy.mockRestore();
  });

  it("note une adresse absente ou non confirmée comme un échec, sans rien envoyer", async () => {
    const { store, summary, fetchImpl } = await run({
      snapshots: { [USER]: [snapshot()] },
      email: null,
    });
    expect(store.markFailed).toHaveBeenCalledWith(["result-1"], { error: "email_unavailable" });
    expect(summary.emailsFailed).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("échoue quand une alerte est due et que Resend n'est pas configuré, sans rien réserver", async () => {
    const { summary, store, fetchImpl } = await run(
      { snapshots: { [USER]: [snapshot()] } },
      { env: {} },
    );
    expect(summary).toMatchObject({ configured: false, dueUnsent: 1, emailsSent: 0 });
    expect(summary.missingConfig).toEqual(["RESEND_API_KEY", "ALERT_EMAIL_FROM", "SITE_URL"]);
    expect(store.claim).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => assertSaleResultsComplete(summary)).toThrow(
      /1 envoi\(s\) dû\(s\) mais l'envoi d'e-mails n'est pas configuré.*RESEND_API_KEY/,
    );
  });

  it("réussit sans Resend quand rien n'est dû", async () => {
    const { summary } = await run({}, { env: {} });
    expect(summary.dueUnsent).toBe(0);
    expect(() => assertSaleResultsComplete(summary)).not.toThrow();
  });

  it("fait échouer le passage quand une lecture échoue, plutôt que de conclure à l'absence d'alerte", async () => {
    const made = makeStore();
    made.store.recentSnapshots.mockRejectedValueOnce(new Error("base injoignable"));
    await expect(run({}, { journal: made })).rejects.toThrow("base injoignable");
  });
});
