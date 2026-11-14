import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAutopilotStats,
  type AutopilotSettings,
} from "@/lib/information-agent/autopilot-rules";
import { autopilotCodeLabel, buildAutopilotView } from "@/lib/information-agent/autopilot-view";

/**
 * Libellés des codes du pilote (T31 et P12, 14/11/2026) : aucun code brut dans « Derniers événements ». La table
 * des libellés ne doit pas dériver des fichiers qui écrivent les codes : ce test les relit.
 */
const PILOT_SOURCES = [
  "src/lib/information-agent/autopilot-rules.ts",
  "src/lib/information-agent/autopilot-candidates.ts",
  "src/lib/information-agent/autopilot-send-guard.ts",
  "src/lib/information-agent-autopilot.ts",
];

/**
 * Valeurs de données que les mêmes formes d'écriture rendent sans être des motifs : origine d'une adresse
 * (`candidateSourceKind`) et canal d'observation (garde de l'envoi). Elles ne s'affichent jamais seules.
 */
const DATA_VALUES = ["sale_listing", "licitor_cloudflare_decoded"];

/** Codes écrits en toutes lettres : refus, motifs écartés, erreurs, arrêts, gardes de tête. */
function codesWrittenByThePilot(): string[] {
  const patterns = [
    /\bno\("([a-z0-9_]+)"\)/g,
    /\breturn "([a-z0-9_]+)";/g,
    /\bcode: "([a-z0-9_]+)"/g,
    /\bskip\("([a-z0-9_]+)"\)/g,
    /\bskip: "([a-z0-9_]+)"/g,
    /\bskipped: \{ ([a-z0-9_]+): /g,
    /\brunError\("([a-z0-9_]+)"/g,
    /\brefuse\("([a-z0-9_]+)"\)/g,
    /\bstopWith\("([a-z0-9_]+)"\)/g,
    /\bautoStop\("([a-z0-9_]+)"/g,
    /\bfinish\("[a-z]+", "([a-z0-9_]+)"\)/g,
    /\?\s*"([a-z0-9_]+)"\s*:\s*(?:"([a-z0-9_]+)"|null)/g,
  ];
  const codes = new Set<string>();
  for (const file of PILOT_SOURCES) {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        for (const code of match.slice(1)) if (code) codes.add(code);
      }
    }
  }
  for (const value of DATA_VALUES) codes.delete(value);
  return [...codes].sort();
}

const settings = (overrides: Partial<AutopilotSettings> = {}): AutopilotSettings => ({
  mode: "simulation",
  actingAdminId: "admin-1",
  capTotalOverride: null,
  allowLicitorDecoded: false,
  liveAllowed: false,
  art14RuleEnabled: true,
  art14MaxAgeDays: 30,
  aipdAttestedAt: null,
  aipdVersion: null,
  simulationStartedAt: "2026-11-14T10:47:00Z",
  pausedUntil: null,
  autoStoppedAt: null,
  autoStopReason: null,
  ...overrides,
});

function view(
  events: Array<{ kind: string; reason?: string | null; details?: unknown }>,
  overrides: Partial<AutopilotSettings> = {},
) {
  return buildAutopilotView({
    settings: settings(overrides),
    stats: parseAutopilotStats({}),
    readiness: { ready: false, checks: [] },
    env: {},
    now: new Date("2026-11-16T08:41:00Z"),
    events: events.map((event) => ({
      at: "2026-11-16T08:40:00Z",
      kind: event.kind,
      reason: event.reason ?? null,
      details: event.details ?? {},
    })),
    lastRunAt: null,
    prepared: { total: 0, items: [] },
  });
}

describe("libellés des codes du pilote", () => {
  const codes = codesWrittenByThePilot();

  it("trouve les codes écrits par les fichiers du pilote", () => {
    expect(codes).toEqual(
      expect.arrayContaining([
        "policy_rejected",
        "draft_stale",
        "simulated_draft_pending",
        "recipient_cooldown",
        "simulated_backlog",
        "mark_failed",
        "art14_window_expired",
        "cap_reached",
        "not_live",
        "policy_rejections",
        "not_production",
        "busy",
      ]),
    );
  });

  it.each(codes)("donne un libellé français au code %s", (code) => {
    expect(autopilotCodeLabel(code)).toEqual(expect.any(String));
  });

  it("ne remonte pas au prototype", () => {
    expect(autopilotCodeLabel("constructor")).toBeNull();
  });
});

describe("derniers événements : des libellés, jamais un code brut", () => {
  it("candidat écarté, refus au dernier contrôle, erreur du fournisseur", () => {
    const { events } = view([
      { kind: "skip", details: { code: "policy_rejected", saleId: "s-1", blockers: 1 } },
      { kind: "skip", details: { code: "send_refused", reason: "not_live", saleId: "s-1" } },
      { kind: "send_error", details: { status: 429 } },
      { kind: "send_error", details: { status: 500 } },
      { kind: "skip", details: { code: "code_futur" } },
    ]);
    expect(events.map((event) => [event.label, event.detail])).toEqual([
      ["Candidat écarté", "rejet de politique à l’aperçu"],
      ["Candidat écarté", "refusé au dernier contrôle avant l’envoi : pilote plus en mode réel"],
      ["Erreur d’envoi", "limite de débit du fournisseur"],
      ["Erreur d’envoi", "erreur du fournisseur d’envoi"],
      // Un code inconnu est signalé comme tel, jamais affiché comme s'il était un libellé.
      ["Candidat écarté", "motif non répertorié (code_futur)"],
    ]);
  });

  it("passage : comptes, candidats écartés et erreurs par motif ; contrôle de préparation non satisfait", () => {
    const { events } = view([
      {
        kind: "run",
        details: {
          examined: 7,
          prepared: 2,
          would_send: 2,
          sent: 0,
          skip_simulated_draft_pending: 3,
          skip_licitor_decoded_refused: 30,
          skip_draft_stale: 1,
          error_mark_failed: 1,
        },
      },
      {
        kind: "run",
        details: { examined: 0, prepared: 0, would_send: 0, sent: 0, skip_simulated_backlog: 1 },
      },
      { kind: "run", details: { code: "not_ready", failed: ["aipd", "live_allowed"] } },
    ]);
    expect(events.map((event) => event.detail)).toEqual([
      "7 examinées, 2 préparées, 2 simulées, 0 envoyées · écartées : brouillon simulé déjà en attente de validation (3), adresse Licitor décodée, non ouverte au pilote (30), brouillon caduc (vente changée), annulé (1) · en erreur : brouillon simulé non marqué (1)",
      "0 examinées, 0 préparées, 0 simulées, 0 envoyées · écartées : plafond des brouillons simulés en attente atteint (1)",
      "contrôle de préparation au mode réel non satisfait",
    ]);
    for (const event of events) expect(event.detail).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("arrêt automatique : son motif en clair, dans le journal et dans l'avis", () => {
    const result = view([{ kind: "auto_stop", reason: "policy_rejections" }], {
      mode: "off",
      autoStoppedAt: "2026-11-16T08:40:00Z",
      autoStopReason: "policy_rejections",
    });
    expect(result.events[0].detail).toBe("deux rejets de politique ou de contenu en 7 jours");
    expect(result.notice?.text).toContain("deux rejets de politique ou de contenu en 7 jours");
    expect(result.runs).toBe(
      "Dernier passage : aucun · prochain passage : aucun (arrêt automatique, réactivation manuelle)",
    );
  });
});

describe("article 14 dans la vue", () => {
  it("dit que la règle s'applique toujours, avec son délai et ses bornes", () => {
    expect(view([]).settings.art14Label).toBe(
      "appliqué à chaque candidat, non désactivable · délai d’information : 30 jours (réglable de 1 à 90)",
    );
  });

  it("une valeur antérieure à la contrainte de la base est signalée, et le délai affiché est celui appliqué", () => {
    expect(view([], { art14RuleEnabled: false, art14MaxAgeDays: 120 }).settings.art14Label).toBe(
      "désactivé dans les réglages enregistrés (le pilote l’applique quand même) : à rétablir · délai d’information : enregistré : 120 jours, appliqué : 90 : à rétablir (réglable de 1 à 90)",
    );
    expect(view([], { art14MaxAgeDays: 365 }).settings.art14Label).toBe(
      "appliqué à chaque candidat, non désactivable · délai d’information : enregistré : 365 jours, appliqué : 90 : à rétablir (réglable de 1 à 90)",
    );
    // Un délai dans les bornes, jusqu'à 90 jours, est montré tel quel.
    expect(view([], { art14MaxAgeDays: 90 }).settings.art14Label).toBe(
      "appliqué à chaque candidat, non désactivable · délai d’information : 90 jours (réglable de 1 à 90)",
    );
    expect(view([], { art14MaxAgeDays: 20 }).settings.art14Label).toBe(
      "appliqué à chaque candidat, non désactivable · délai d’information : 20 jours (réglable de 1 à 90)",
    );
  });
});
