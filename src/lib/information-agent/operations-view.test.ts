import { describe, expect, it } from "vitest";
import {
  buildInformationAgentOperationsView,
  formatResponseDelay,
  roundtripAgeDays,
  type InformationAgentIndicatorsRaw,
} from "@/lib/information-agent/operations-view";

const NOW = new Date("2026-11-02T12:00:00Z");

function raw(
  overrides: Partial<InformationAgentIndicatorsRaw> = {},
): InformationAgentIndicatorsRaw {
  return {
    since: "2026-10-03T12:00:00Z",
    sent: 12,
    delivered: 10,
    delayed: 1,
    bounced_permanent: 1,
    bounced_temporary: 0,
    complained: 0,
    failed: 0,
    oppositions: 2,
    replies: 3,
    response_median_seconds: 2 * 86_400 + 4 * 3_600,
    response_mean_seconds: 100_000,
    unrouted_pending: 0,
    ...overrides,
  };
}

describe("indicateurs d'exploitation de l'agent", () => {
  it("donne chaque taux avec son effectif, jamais un pourcentage seul", () => {
    const view = buildInformationAgentOperationsView(raw(), null, NOW);
    const value = (key: string) => view.rows.find((row) => row.key === key)?.value;

    expect(value("sent")).toBe("12");
    expect(value("delivered")).toBe("10 sur 12 (83,3 %)");
    expect(value("delayed")).toBe("1 sur 12 (8,3 %)");
    expect(value("bounced_permanent")).toBe("1 sur 12 (8,3 %)");
    expect(value("complained")).toBe("0 sur 12 (0 %)");
    expect(value("oppositions")).toBe("2 sur 12 (16,7 %)");
    expect(value("replies")).toBe("3 sur 12 (25 %)");
    expect(value("delay")).toBe("2 j 4 h sur 3 réponses");
    for (const row of view.rows) expect(row.value).not.toMatch(/^\d+(?:,\d+)? %$/);
  });

  it("sans envoi, n'affiche aucun taux", () => {
    const view = buildInformationAgentOperationsView(
      raw({ sent: 0, delivered: 0, replies: 0 }),
      null,
      NOW,
    );
    expect(view.rows.map((row) => row.key)).toEqual(["sent", "none"]);
    expect(view.rows[1]?.value).toBe("aucun envoi sur la période");
  });

  it("signale un rebond définitif ou une plainte, et les messages sans dossier à traiter", () => {
    const view = buildInformationAgentOperationsView(
      raw({ complained: 1, unrouted_pending: 2 }),
      null,
      NOW,
    );
    const tone = (key: string) => view.rows.find((row) => row.key === key)?.tone;
    expect(tone("complained")).toBe("alert");
    expect(tone("bounced_permanent")).toBe("alert");
    expect(tone("unrouted")).toBe("warn");
  });

  it("délai de réponse lisible", () => {
    expect(formatResponseDelay(null)).toBe("aucune réponse");
    expect(formatResponseDelay(600)).toBe("moins d’une heure");
    expect(formatResponseDelay(5 * 3600)).toBe("5 h");
    expect(formatResponseDelay(3 * 86_400)).toBe("3 j");
    expect(formatResponseDelay(3 * 86_400 + 5 * 3600)).toBe("3 j 5 h");
  });

  it("l'aller-retour est périmé après 30 jours ou s'il n'a jamais été vérifié", () => {
    const fresh = buildInformationAgentOperationsView(raw(), "2026-10-20T12:00:00Z", NOW);
    expect(fresh.roundtrip).toMatchObject({ stale: false, label: "Vérifié il y a 13 jours." });
    const today = buildInformationAgentOperationsView(raw(), "2026-11-02T08:00:00Z", NOW);
    expect(today.roundtrip.label).toBe("Vérifié aujourd’hui.");
    const old = buildInformationAgentOperationsView(raw(), "2026-09-30T12:00:00Z", NOW);
    expect(old.roundtrip).toMatchObject({ stale: true });
    expect(old.roundtrip.label).toContain("à refaire");
    const never = buildInformationAgentOperationsView(raw(), null, NOW);
    expect(never.roundtrip.stale).toBe(true);
    expect(roundtripAgeDays(null, NOW)).toBeNull();
  });
});
