import { describe, expect, it } from "vitest";
import {
  autopilotBudgetDecision,
  autopilotCaps,
  autopilotPhase,
  autopilotRunGate,
  evaluateAutopilotCandidate,
  evaluateAutopilotSafety,
  parseAutopilotStats,
  type AutopilotCandidateFacts,
  type AutopilotSettings,
  type AutopilotStats,
} from "@/lib/information-agent/autopilot-rules";
import {
  frenchPublicHolidays,
  isWithinAutopilotSendWindow,
} from "@/lib/information-agent/paris-time";

const NOW = new Date("2026-11-03T09:30:00Z"); // mardi 10 h 30 à Paris

const stats = (overrides: Partial<AutopilotStats> = {}): AutopilotStats => ({
  ...parseAutopilotStats({}),
  ...overrides,
});

const settings = (overrides: Partial<AutopilotSettings> = {}): AutopilotSettings => ({
  mode: "simulation",
  actingAdminId: "admin-1",
  capTotalOverride: null,
  allowLicitorDecoded: false,
  liveAllowed: true,
  art14RuleEnabled: true,
  art14MaxAgeDays: 30,
  aipdAttestedAt: null,
  aipdVersion: null,
  simulationStartedAt: null,
  pausedUntil: null,
  autoStoppedAt: null,
  autoStopReason: null,
  ...overrides,
});

describe("plage d'envoi (Europe/Paris)", () => {
  it.each([
    ["mardi 10 h 30 (hiver)", "2026-11-03T09:30:00Z", true],
    ["mardi 9 h 29", "2026-11-03T08:29:00Z", false],
    ["mardi 9 h 30 pile", "2026-11-03T08:30:00Z", true],
    ["mardi 11 h 30 pile : borne exclue", "2026-11-03T10:30:00Z", false],
    ["mardi 13 h 59", "2026-11-03T12:59:00Z", false],
    ["mardi 14 h 00", "2026-11-03T13:00:00Z", true],
    ["mardi 16 h 29", "2026-11-03T15:29:00Z", true],
    ["mardi 16 h 30 : borne exclue", "2026-11-03T15:30:00Z", false],
    ["nuit", "2026-11-03T02:00:00Z", false],
    ["samedi 10 h", "2026-11-07T09:00:00Z", false],
    ["dimanche 15 h", "2026-11-08T14:00:00Z", false],
    [
      "jour férié (Toussaint, un dimanche en 2026) : 11 novembre, mercredi",
      "2026-11-11T09:00:00Z",
      false,
    ],
    ["lundi de Pâques 2026 (6 avril)", "2026-04-06T09:00:00Z", false],
    ["Ascension 2026 (14 mai)", "2026-05-14T09:00:00Z", false],
    ["lundi de Pentecôte 2026 (25 mai)", "2026-05-25T09:00:00Z", false],
    ["été : mercredi 8 juillet 10 h Paris = 8 h UTC", "2026-07-08T08:00:00Z", true],
    ["été : 11 h 30 Paris = 9 h 30 UTC, borne exclue", "2026-07-08T09:30:00Z", false],
    ["changement d'heure d'été : lundi 30 mars 10 h (9 h → UTC+2)", "2026-03-30T08:00:00Z", true],
    ["changement d'heure d'hiver : lundi 26 octobre 10 h (UTC+1)", "2026-10-26T09:00:00Z", true],
  ])("%s -> %s", (_label, iso, expected) => {
    expect(isWithinAutopilotSendWindow(new Date(iso))).toBe(expected);
  });

  it("calcule les jours fériés mobiles de plusieurs années", () => {
    expect(frenchPublicHolidays(2026)).toEqual(
      new Set([
        "2026-01-01",
        "2026-05-01",
        "2026-05-08",
        "2026-07-14",
        "2026-08-15",
        "2026-11-01",
        "2026-11-11",
        "2026-12-25",
        "2026-04-06",
        "2026-05-14",
        "2026-05-25",
      ]),
    );
    expect(frenchPublicHolidays(2027).has("2027-03-29")).toBe(true); // lundi de Pâques 2027
    expect(frenchPublicHolidays(2025).has("2025-04-21")).toBe(true);
  });

  it("le garde de passage dit pourquoi il ne passe pas", () => {
    expect(autopilotRunGate(settings({ mode: "off" }), NOW)).toEqual({
      ok: false,
      code: "disabled",
    });
    expect(autopilotRunGate(settings({ autoStoppedAt: "2026-11-01T10:00:00Z" }), NOW)).toEqual({
      ok: false,
      code: "auto_stopped",
    });
    expect(autopilotRunGate(settings({ pausedUntil: "2026-11-04T09:00:00Z" }), NOW)).toEqual({
      ok: false,
      code: "paused",
    });
    expect(autopilotRunGate(settings(), new Date("2026-11-03T02:00:00Z"))).toEqual({
      ok: false,
      code: "outside_window",
    });
    expect(autopilotRunGate(settings(), NOW)).toEqual({ ok: true });
  });
});

describe("phases et plafonds", () => {
  const first = "2026-10-01T10:00:00Z";
  const clean = (week: number) => ({ week, sent: 10, complaints: 0, permanent_bounces: 0 });

  it.each([
    [0, 1, 5, 3],
    [8, 2, 10, 12],
    [15, 3, 20, 12],
    [22, 4, 30, 12],
    [29, 5, 40, 12],
    [200, 5, 40, 12],
  ])(
    "jour %i après le premier envoi propre : phase %i, %i par jour, %i par heure",
    (days, index, day, hour) => {
      const now = new Date(Date.parse(first) + days * 86_400_000);
      const phase = autopilotPhase(first, [0, 1, 2, 3].map(clean), now);
      expect([phase.index, phase.dayCap, phase.hourCap]).toEqual([index, day, hour]);
    },
  );

  it("sans envoi réel, on reste en semaine 1", () => {
    expect(autopilotPhase(null, [], NOW).index).toBe(1);
  });

  it("ne passe pas à la phase suivante si la semaine précédente n'est pas propre", () => {
    const now = new Date(Date.parse(first) + 15 * 86_400_000);
    const dirty = [clean(0), { week: 1, sent: 10, complaints: 1, permanent_bounces: 0 }, clean(2)];
    expect(autopilotPhase(first, dirty, now).index).toBe(2);
    const bounces = [clean(0), { week: 1, sent: 10, complaints: 0, permanent_bounces: 1 }];
    expect(autopilotPhase(first, bounces, now).index).toBe(2);
  });

  it("le plafond effectif est le minimum entre la phase, le réglage, l'environnement et le plafond dur", () => {
    const base = { firstAutopilotSendAt: first, weeks: [0, 1, 2, 3].map(clean) };
    const late = new Date(Date.parse(first) + 60 * 86_400_000);
    expect(autopilotCaps(base, { capTotalOverride: null }, {}, late).dayCap).toBe(40);
    expect(autopilotCaps(base, { capTotalOverride: 12 }, {}, late).dayCap).toBe(12);
    expect(
      autopilotCaps(
        base,
        { capTotalOverride: 30 },
        { INFORMATION_AGENT_AUTOPILOT_DAILY_CAP: "7" },
        late,
      ).dayCap,
    ).toBe(7);
    expect(
      autopilotCaps(
        base,
        { capTotalOverride: null },
        { INFORMATION_AGENT_AUTOPILOT_DAILY_CAP: "500" },
        late,
      ).dayCap,
    ).toBe(40);
    expect(
      autopilotCaps(
        base,
        { capTotalOverride: null },
        { INFORMATION_AGENT_AUTOPILOT_DAILY_CAP: "x" },
        late,
      ).dayCap,
    ).toBe(40);
  });
});

describe("budget d'un envoi", () => {
  const caps = { dayCap: 5, hourCap: 3, phase: autopilotPhase(null, [], NOW) };
  const decide = (
    s: Partial<AutopilotStats>,
    extra: { domain?: string | null; court?: string | null; random?: number } = {},
  ) =>
    autopilotBudgetDecision({
      stats: stats(s),
      caps,
      domain: extra.domain ?? "cabinet-a.fr",
      court: extra.court ?? "T1",
      now: NOW,
      random: extra.random ?? 0.5,
    });

  it("accepte quand rien n'est atteint", () => {
    expect(decide({})).toEqual({ ok: true });
  });
  it("plafond du jour, manuels inclus (le total compte tous les envois)", () => {
    expect(decide({ sentTodayTotal: 5 })).toEqual({ ok: false, scope: "run", code: "cap_reached" });
    expect(decide({ sentTodayTotal: 4 })).toEqual({ ok: true });
  });
  it("plafond de l'heure", () => {
    expect(decide({ sentLastHourTotal: 3 })).toEqual({ ok: false, scope: "run", code: "hour_cap" });
  });
  it("intervalle aléatoire de 2 à 12 minutes depuis le dernier envoi", () => {
    const at = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
    expect(decide({ lastSendAt: at(1) }, { random: 0 }).ok).toBe(false);
    expect(decide({ lastSendAt: at(3) }, { random: 0 }).ok).toBe(true);
    expect(decide({ lastSendAt: at(3) }, { random: 0.5 })).toMatchObject({
      ok: false,
      code: "interval",
    });
    expect(decide({ lastSendAt: at(13) }, { random: 0.999 }).ok).toBe(true);
  });
  it("un cabinet : 1 par jour et 2 par 7 jours, 15 minutes entre deux envois", () => {
    expect(decide({ todayByDomain: { "cabinet-a.fr": 1 } })).toEqual({
      ok: false,
      scope: "candidate",
      code: "domain_cap",
    });
    expect(decide({ weekByDomain: { "cabinet-a.fr": 2 } })).toMatchObject({ code: "domain_cap" });
    expect(decide({ weekByDomain: { "cabinet-a.fr": 1 } })).toEqual({ ok: true });
    expect(decide({ recentDomains: ["cabinet-a.fr"] })).toMatchObject({ code: "domain_spacing" });
    expect(decide({ todayByDomain: { "cabinet-b.fr": 1 } })).toEqual({ ok: true });
  });
  it("un tribunal : 3 par jour, on passe au candidat suivant", () => {
    expect(decide({ todayByCourt: { T1: 3 } })).toEqual({
      ok: false,
      scope: "candidate",
      code: "court_cap",
    });
    expect(decide({ todayByCourt: { T2: 3 } })).toEqual({ ok: true });
  });
});

describe("candidat du pilote", () => {
  const ok: AutopilotCandidateFacts = {
    sourceKind: "sale_listing",
    recipientRole: "lawyer",
    selectedUnambiguously: true,
    identityComplete: true,
    addressHygieneIssue: null,
    consumerDomain: false,
    observationChannel: null,
    addressObservedAt: "2026-10-20T10:00:00Z",
    mailDomain: "ok",
    saleDate: "2026-12-01T10:00:00Z",
    hasUnpublishedGap: true,
    humanDraftExists: false,
    identityExcluded: false,
    contactFirstRecordedAt: "2026-10-20T10:00:00Z",
    alreadyInformed: false,
    lastReplyAt: null,
    silentSendsInSixMonths: 0,
    lastSendAt: null,
  };
  const verdict = (facts: Partial<AutopilotCandidateFacts>, s: Partial<AutopilotSettings> = {}) =>
    evaluateAutopilotCandidate({ ...ok, ...facts }, settings(s), NOW);

  it("accepte l'avocat poursuivant de l'annonce", () => {
    expect(verdict({})).toEqual({ ok: true });
  });

  it.each([
    ["greffe de secours", { sourceKind: "court_registry_fallback" }, "court_registry_refused"],
    ["adresse retrouvée par recherche", { sourceKind: "agent_search" }, "source_not_sale_listing"],
    [
      "origine de l'adresse absente (aucune valeur par défaut)",
      { sourceKind: null },
      "source_not_sale_listing",
    ],
    ["saisie d'administrateur", { sourceKind: "admin_entry" }, "source_not_sale_listing"],
    ["annuaire officiel", { sourceKind: "official_directory" }, "source_not_sale_listing"],
    ["notaire", { recipientRole: "notary" }, "role_not_lawyer"],
    ["organisateur de la vente", { recipientRole: "organizer" }, "role_not_lawyer"],
    ["contact générique", { recipientRole: "source_contact" }, "role_not_lawyer"],
    [
      "plusieurs adresses ou confiance faible",
      { selectedUnambiguously: false },
      "contact_ambiguous",
    ],
    [
      "identité incomplète (sans barreau ni ville)",
      { identityComplete: false },
      "identity_incomplete",
    ],
    ["adresse mal formée", { addressHygieneIssue: "artifact" }, "address_invalid"],
    ["messagerie grand public", { consumerDomain: true }, "consumer_domain"],
    [
      "adresse Licitor décodée sans réglage",
      { observationChannel: "licitor_cloudflare_decoded" },
      "licitor_decoded_refused",
    ],
    [
      "adresse relevée il y a plus de 6 mois",
      { addressObservedAt: "2026-04-01T10:00:00Z" },
      "address_stale",
    ],
    ["adresse sans date de relevé", { addressObservedAt: null }, "address_stale"],
    ["domaine sans messagerie", { mailDomain: "no_mail" }, "mx_invalid"],
    ["audience dans moins de 10 jours", { saleDate: "2026-11-10T10:00:00Z" }, "sale_too_soon"],
    ["audience inconnue", { saleDate: null }, "sale_too_soon"],
    [
      "aucune lacune sur des pièces ou faits non publiés",
      { hasUnpublishedGap: false },
      "no_unpublished_gap",
    ],
    ["brouillon d'un administrateur existant", { humanDraftExists: true }, "admin_draft_exists"],
    ["identité exclue (mauvais destinataire)", { identityExcluded: true }, "identity_excluded"],
    ["90 jours de pause après une réponse", { lastReplyAt: "2026-09-10T10:00:00Z" }, "reply_pause"],
    [
      "6 mois sans envoi après 2 silences",
      { silentSendsInSixMonths: 2, lastSendAt: "2026-08-01T10:00:00Z" },
      "silence_pause",
    ],
  ])("refuse : %s", (_label, facts, code) => {
    expect(verdict(facts as Partial<AutopilotCandidateFacts>)).toEqual({ ok: false, code });
  });

  it("accepte l'adresse Licitor décodée seulement quand le réglage est activé", () => {
    expect(
      verdict({ observationChannel: "licitor_cloudflare_decoded" }, { allowLicitorDecoded: true }),
    ).toEqual({ ok: true });
  });

  it("une panne DNS (inconnu) ne bloque pas", () => {
    expect(verdict({ mailDomain: "unknown" })).toEqual({ ok: true });
  });

  it("la pause de 90 jours se lève après 90 jours, celle de 6 mois après 6 mois", () => {
    expect(verdict({ lastReplyAt: "2026-07-01T10:00:00Z" })).toEqual({ ok: true });
    expect(verdict({ silentSendsInSixMonths: 1, lastSendAt: "2026-10-01T10:00:00Z" })).toEqual({
      ok: true,
    });
    expect(verdict({ silentSendsInSixMonths: 2, lastSendAt: "2026-04-01T10:00:00Z" })).toEqual({
      ok: true,
    });
  });

  describe("délai d'information de l'article 14", () => {
    it("accepte une adresse enregistrée il y a moins de 30 jours", () => {
      expect(verdict({ contactFirstRecordedAt: "2026-10-20T10:00:00Z" })).toEqual({ ok: true });
      expect(verdict({ contactFirstRecordedAt: "2026-11-02T10:00:00Z" })).toEqual({ ok: true });
    });
    it("refuse quand la date du premier enregistrement est absente (règle invérifiable)", () => {
      expect(verdict({ contactFirstRecordedAt: null })).toEqual({
        ok: false,
        code: "art14_unknown",
      });
      expect(verdict({ contactFirstRecordedAt: null, alreadyInformed: true })).toEqual({
        ok: true,
      });
    });
    it("refuse une adresse enregistrée depuis plus de 30 jours et jamais informée", () => {
      expect(verdict({ contactFirstRecordedAt: "2026-09-01T10:00:00Z" })).toEqual({
        ok: false,
        code: "art14_window_expired",
      });
    });
    it("accepte une adresse ancienne dont la personne a déjà été informée", () => {
      expect(
        verdict({ contactFirstRecordedAt: "2026-09-01T10:00:00Z", alreadyInformed: true }),
      ).toEqual({ ok: true });
    });
    it("la règle est réglable : délai allongé, ou règle désactivée", () => {
      const old = { contactFirstRecordedAt: "2026-09-01T10:00:00Z" };
      expect(verdict(old, { art14MaxAgeDays: 90 })).toEqual({ ok: true });
      expect(verdict(old, { art14RuleEnabled: false })).toEqual({ ok: true });
    });
  });
});

describe("arrêt automatique", () => {
  it("rien à signaler sur des compteurs vides", () => {
    expect(evaluateAutopilotSafety(stats())).toEqual({ stop: null, pause: null, warnings: [] });
  });

  it.each([
    [
      "une plainte sur les 100 premiers envois",
      { autopilotTotal: 40, first100Complaints: 1 },
      "complaint",
    ],
    [
      "deux plaintes sur 14 jours après les 100 premiers envois",
      { autopilotTotal: 150, complaints14d: 2 },
      "complaints_14d",
    ],
    [
      "3 rebonds définitifs sur les 30 premiers envois",
      { first30PermanentBounces: 3 },
      "bounce_early",
    ],
    [
      "3 % de rebonds définitifs sur 100 envois mûrs",
      { matureTotal: 100, maturePermanentBounces: 3 },
      "bounce_rate",
    ],
    ["2 rejets de politique ou de contenu en 7 jours", { rejected7d: 2 }, "policy_rejections"],
    [
      "remis sous 95 % sur 24 h (20 envois)",
      { last24hSent: 20, last24hDelivered: 18 },
      "delivery_rate",
    ],
    [
      "6 % d'oppositions sur 14 jours (au moins 3)",
      { oppositions14d: 3, sent14d: 40 },
      "oppositions",
    ],
    ["3 erreurs d'API consécutives", { consecutiveApiErrors: 3 }, "api_errors"],
    ["un envoi à vérifier", { unverifiedOpen: 1 }, "unverified_send"],
    ["échec de domaine ou de quota côté fournisseur", { last24hFailed: 1 }, "email_failed"],
  ])("arrête : %s", (_label, overrides, code) => {
    expect(evaluateAutopilotSafety(stats(overrides)).stop).toEqual({ code });
  });

  it.each([
    [
      "2 plaintes avant 100 envois ne comptent pas comme la règle des 14 jours",
      { autopilotTotal: 50, complaints14d: 2 },
    ],
    ["2 rebonds sur 30", { first30PermanentBounces: 2 }],
    ["2,9 % de rebonds sur 100 envois mûrs", { matureTotal: 100, maturePermanentBounces: 2 }],
    ["un seul rejet", { rejected7d: 1 }],
    ["remis à 95 % sur 20 envois", { last24hSent: 20, last24hDelivered: 19 }],
    ["19 envois seulement : pas de taux de remise", { last24hSent: 19, last24hDelivered: 0 }],
    ["2 oppositions seulement", { oppositions14d: 2, sent14d: 10 }],
    ["2 erreurs d'API", { consecutiveApiErrors: 2 }],
  ])("n'arrête pas : %s", (_label, overrides) => {
    expect(evaluateAutopilotSafety(stats(overrides)).stop).toBeNull();
  });

  it("met le pilote en pause 24 h quand 20 % des envois sont retardés", () => {
    expect(evaluateAutopilotSafety(stats({ last24hSent: 10, last24hDelayed: 2 })).pause).toEqual({
      code: "delayed_24h",
      hours: 24,
    });
    expect(evaluateAutopilotSafety(stats({ last24hSent: 10, last24hDelayed: 1 })).pause).toBeNull();
    expect(evaluateAutopilotSafety(stats({ last24hSent: 4, last24hDelayed: 4 })).pause).toBeNull();
  });

  it("alerte à la moitié des seuils d'arrêt", () => {
    const verdict = evaluateAutopilotSafety(
      stats({
        first30PermanentBounces: 2,
        rejected7d: 1,
        consecutiveApiErrors: 2,
        oppositions14d: 2,
        sent14d: 40,
        last24hSent: 10,
        last24hDelayed: 1,
      }),
    );
    expect(verdict.stop).toBeNull();
    expect(verdict.warnings.sort()).toEqual(
      ["api_errors", "bounce_early", "delayed_24h", "oppositions", "policy_rejections"].sort(),
    );
  });
});

describe("lecture des compteurs de la base", () => {
  it("tolère les champs absents ou invalides", () => {
    expect(parseAutopilotStats(null).sentTodayTotal).toBe(0);
    const parsed = parseAutopilotStats({
      sent_today_total: 4,
      today_by_domain: { "a.fr": 1, "b.fr": "x" },
      weeks: [{ week: 0, sent: 3, complaints: 0, permanent_bounces: 1 }],
      last_send_at: "2026-11-03T08:00:00Z",
    });
    expect(parsed).toMatchObject({
      sentTodayTotal: 4,
      todayByDomain: { "a.fr": 1, "b.fr": 0 },
      lastSendAt: "2026-11-03T08:00:00Z",
    });
    expect(parsed.weeks).toEqual([{ week: 0, sent: 3, complaints: 0, permanent_bounces: 1 }]);
  });
});
