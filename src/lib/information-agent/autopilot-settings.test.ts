import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  rows: [] as Array<Record<string, unknown>> | null,
  error: null as Error | null,
  /** Ligne des réglages (`maybeSingle`). */
  settingsRow: null as Record<string, unknown> | null,
  calls: [] as Array<{ method: string; args: unknown[] }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const query = {
    select: (...args: unknown[]) => (mocks.calls.push({ method: "select", args }), query),
    eq: (...args: unknown[]) => (mocks.calls.push({ method: "eq", args }), query),
    contains: (...args: unknown[]) => (mocks.calls.push({ method: "contains", args }), query),
    not: (...args: unknown[]) => (mocks.calls.push({ method: "not", args }), query),
    order: (...args: unknown[]) => (mocks.calls.push({ method: "order", args }), query),
    gte: (...args: unknown[]) => (mocks.calls.push({ method: "gte", args }), query),
    in: (...args: unknown[]) => (mocks.calls.push({ method: "in", args }), query),
    limit: (...args: unknown[]) => {
      mocks.calls.push({ method: "limit", args });
      return Promise.resolve({ data: mocks.rows, error: mocks.error });
    },
    maybeSingle: () => {
      mocks.calls.push({ method: "maybeSingle", args: [] });
      return Promise.resolve({ data: mocks.settingsRow, error: null });
    },
  };
  return {
    supabaseAdmin: {
      rpc: mocks.rpc,
      from: (table: string) => (mocks.calls.push({ method: "from", args: [table] }), query),
    },
  };
});

import { autopilotBudgetDecision, autopilotPhase } from "@/lib/information-agent/autopilot-rules";
import {
  evaluateAutopilotSilence,
  lastOnDemandAutopilotRunAt,
  loadAutopilotStats,
  loadLastAutopilotRunAt,
  sanitizeAutopilotEventDetails,
} from "@/lib/information-agent/autopilot-settings";

// Adresses fictives : sous-domaine inexistant de `notaires.fr`, `example.test`.
const NOW = new Date("2026-11-03T09:30:00Z"); // mardi 10 h 30 à Paris
const at = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const row = (overrides: Record<string, unknown>) => ({
  recipient_email: "etude@exemple-fictif.notaires.fr",
  approved_at: at(1),
  status: "sent",
  send_outcome: null,
  office_code: "33001",
  selected_email: "etude@exemple-fictif.notaires.fr",
  ...overrides,
});

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({
    data: { sent_today_total: 2, today_by_domain: { "exemple-fictif.notaires.fr": 2 } },
    error: null,
  });
  mocks.rows = [];
  mocks.error = null;
  mocks.settingsRow = null;
  mocks.calls.length = 0;
});

describe("compteurs du pilote : envois par structure sur un domaine partagé", () => {
  it("complète les compteurs SQL par une lecture seule des missions envoyées", async () => {
    mocks.rows = [
      row({}),
      // Même office, hier : compte pour la semaine, pas pour le jour.
      row({ approved_at: at(30) }),
      // Adresse changée par l'administrateur : le code d'office du brouillon ne vaut plus, la boîte compte.
      row({ recipient_email: "autre.boite@exemple-fictif.notaires.fr" }),
      // Échec ordinaire : rien n'est parti. Échec « à vérifier » : l'email est peut-être parti.
      row({ status: "failed", office_code: "75012" }),
      row({ status: "failed", send_outcome: "unverified", office_code: "75012" }),
      // Domaine propre : déjà compté par domaine dans la fonction SQL.
      row({ recipient_email: "contact@example.test", selected_email: "contact@example.test" }),
    ];
    const stats = await loadAutopilotStats(NOW);
    expect(stats.sentTodayTotal).toBe(2);
    expect(stats.todayByDomain).toEqual({ "exemple-fictif.notaires.fr": 2 });
    expect(stats.todayBySharedStructure).toEqual({
      "office|33001": 1,
      "mailbox|autre.boite@exemple-fictif.notaires.fr": 1,
      "office|75012": 1,
    });
    expect(stats.weekBySharedStructure).toEqual({
      "office|33001": 2,
      "mailbox|autre.boite@exemple-fictif.notaires.fr": 1,
      "office|75012": 1,
    });
    expect(stats.sharedStructureCountsComplete).toBe(true);
    // Lecture seule : une table, aucune écriture, et jamais tout `metadata`.
    expect(mocks.calls.map((call) => call.method)).toEqual([
      "from",
      "select",
      "gte",
      "in",
      "limit",
    ]);
    expect(mocks.calls[0].args).toEqual(["information_agent_missions"]);
    expect(String(mocks.calls[1].args[0])).not.toMatch(/(^|,)metadata(,|$)/);
  });

  it("propage une lecture impossible : un plafond illisible ne vaut pas autorisation", async () => {
    mocks.error = new Error("base indisponible");
    await expect(loadAutopilotStats(NOW)).rejects.toThrow("base indisponible");
    mocks.error = null;
    mocks.rows = null;
    await expect(loadAutopilotStats(NOW)).rejects.toThrow("returned no data");
  });

  it("au-delà de 1 000 lignes : compte rendu incomplet, sans erreur, et le pilote n'écrit plus en domaine partagé", async () => {
    mocks.rows = Array.from({ length: 1000 }, () => row({}));
    const stats = await loadAutopilotStats(NOW);
    // Les compteurs SQL restent lisibles (l'écran d'administration s'affiche).
    expect(stats.sentTodayTotal).toBe(2);
    expect(stats).toMatchObject({
      todayBySharedStructure: {},
      weekBySharedStructure: {},
      sharedStructureCountsComplete: false,
    });
    expect(
      autopilotBudgetDecision({
        stats: { ...stats, todayByDomain: {} },
        caps: { dayCap: 40, hourCap: 12, phase: autopilotPhase(null, [], NOW) },
        domain: "exemple-fictif.notaires.fr",
        structure: { key: "office|75012", sharedDomain: "notaires.fr" },
        court: null,
        now: NOW,
        random: 0.5,
      }),
    ).toEqual({ ok: false, scope: "candidate", code: "structure_count_incomplete" });
  });
});

describe("passages lancés à la main : journal", () => {
  it("lit dans le journal le dernier passage `run` marqué « à la main » depuis la date donnée", async () => {
    const since = new Date("2026-11-14T12:50:00Z");
    mocks.rows = [];
    expect(await lastOnDemandAutopilotRunAt(since)).toBeNull();
    expect(mocks.calls).toEqual([
      { method: "from", args: ["information_agent_autopilot_events"] },
      { method: "select", args: ["at"] },
      { method: "eq", args: ["kind", "run"] },
      { method: "contains", args: ["details", { manual: true }] },
      { method: "gte", args: ["at", "2026-11-14T12:50:00.000Z"] },
      { method: "order", args: ["at", { ascending: false }] },
      { method: "limit", args: [1] },
    ]);
    mocks.rows = [{ at: "2026-11-14T12:56:00+00:00" }];
    expect(await lastOnDemandAutopilotRunAt(since)).toEqual(new Date("2026-11-14T12:56:00Z"));
  });

  it("une lecture impossible du journal est propagée (jamais un passage de plus)", async () => {
    mocks.error = new Error("base indisponible");
    await expect(lastOnDemandAutopilotRunAt(NOW)).rejects.toThrow("base indisponible");
  });

  it("« Dernier passage planifié » : écarte les passages `run` marqués « à la main », même marque", async () => {
    mocks.rows = [{ at: "2026-11-14T12:40:00+00:00" }];
    expect(await loadLastAutopilotRunAt()).toBe("2026-11-14T12:40:00+00:00");
    expect(mocks.calls).toEqual([
      { method: "from", args: ["information_agent_autopilot_events"] },
      { method: "select", args: ["at"] },
      { method: "eq", args: ["kind", "run"] },
      { method: "not", args: ["details", "cs", '{"manual":true}'] },
      { method: "order", args: ["at", { ascending: false }] },
      { method: "limit", args: [1] },
    ]);
    mocks.rows = [];
    expect(await loadLastAutopilotRunAt()).toBeNull();
  });

  it("garde dans le journal la marque « à la main », l'administrateur et le motif", () => {
    expect(
      sanitizeAutopilotEventDetails({
        manual: true,
        actorId: "admin-2",
        reason: "Premier passage demandé",
        examined: 3,
      }),
    ).toEqual({ manual: true, actorId: "admin-2", reason: "Premier passage demandé", examined: 3 });
  });
});

describe("pilote muet : alerte évaluée par la santé opérationnelle", () => {
  const silenceCalls = () =>
    mocks.rpc.mock.calls.filter(
      ([name]) => name === "sync_information_agent_autopilot_silent_alert",
    );

  it("simulation, plage ouverte, 40 minutes de plage sans passage planifié : l'alerte s'ouvre", async () => {
    mocks.settingsRow = { mode: "simulation", simulation_started_at: "2026-11-02T08:00:00Z" };
    mocks.rows = [{ at: "2026-11-03T08:40:00+00:00" }];
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    await expect(evaluateAutopilotSilence(NOW)).resolves.toEqual({
      state: "silent",
      lastScheduledRunAt: "2026-11-03T08:40:00+00:00",
    });
    expect(silenceCalls()).toEqual([
      [
        "sync_information_agent_autopilot_silent_alert",
        {
          p_active: true,
          p_details: {
            mode: "simulation",
            last_scheduled_run_at: "2026-11-03T08:40:00+00:00",
            silent_after_minutes: 40,
            runbook: "docs/runbooks/information-agent.md, section « Si aucun passage n’a lieu »",
          },
        },
      ],
    ]);
  });

  it("seul un passage lancé à la main : le dernier passage planifié l'écarte, l'alerte s'ouvre", async () => {
    mocks.settingsRow = { mode: "simulation" };
    // La base ne rend aucun passage planifié : le seul passage récent porte la marque « à la main ».
    mocks.rows = [];
    mocks.rpc.mockResolvedValue({ data: null, error: null });

    await expect(evaluateAutopilotSilence(NOW)).resolves.toEqual({
      state: "silent",
      lastScheduledRunAt: null,
    });
    expect(mocks.calls).toContainEqual({
      method: "not",
      args: ["details", "cs", '{"manual":true}'],
    });
    expect(silenceCalls()[0]?.[1]).toMatchObject({ p_active: true });
  });

  it("passage planifié récent ou pilote éteint : l'alerte se referme", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.settingsRow = { mode: "simulation" };
    mocks.rows = [{ at: "2026-11-03T09:20:00+00:00" }];
    expect((await evaluateAutopilotSilence(NOW)).state).toBe("active");
    mocks.rows = [];
    mocks.settingsRow = { mode: "off" };
    expect((await evaluateAutopilotSilence(NOW)).state).toBe("active");
    expect(silenceCalls().map(([, args]) => (args as { p_active: boolean }).p_active)).toEqual([
      false,
      false,
    ]);
  });

  it("plage fermée (midi, soir, week-end) : rien n'est écrit, l'alerte garde son état", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    mocks.settingsRow = { mode: "simulation" };
    mocks.rows = [];
    for (const now of ["2026-11-03T11:00:00Z", "2026-11-03T17:30:00Z", "2026-11-07T10:00:00Z"]) {
      expect((await evaluateAutopilotSilence(new Date(now))).state).toBe("unknown");
    }
    expect(silenceCalls()).toEqual([]);
  });

  it("une écriture impossible de l'alerte est propagée", async () => {
    mocks.settingsRow = { mode: "simulation" };
    mocks.rpc.mockResolvedValue({ data: null, error: new Error("fonction absente") });
    await expect(evaluateAutopilotSilence(NOW)).rejects.toThrow("fonction absente");
  });
});
