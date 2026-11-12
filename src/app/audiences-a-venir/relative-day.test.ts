// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelativeDay } from "./relative-day";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderedAt(now: string, dayKey: string): string {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(now));
  const { container } = render(createElement(RelativeDay, { dayKey, label: "le jour" }));
  return container.textContent ?? "";
}

describe("calcul du jour de RelativeDay", () => {
  it("prend le jour à Paris, y compris autour de minuit et du changement d'heure", () => {
    const todayInParis: [string, string][] = [
      ["2026-10-20T08:00:00Z", "2026-10-20"],
      ["2026-10-19T21:59:59Z", "2026-10-19"],
      ["2026-10-19T22:00:00Z", "2026-10-20"],
      ["2026-03-28T23:30:00Z", "2026-03-29"],
      ["2026-03-29T00:30:00Z", "2026-03-29"],
      ["2026-10-24T22:30:00Z", "2026-10-25"],
      ["2026-10-25T23:30:00Z", "2026-10-26"],
      ["2026-12-31T23:30:00Z", "2027-01-01"],
    ];
    for (const [now, dayKey] of todayInParis) {
      expect(renderedAt(now, dayKey)).toBe("le jour (aujourd’hui)");
      cleanup();
    }
  });

  it("compte les jours calendaires, et n'ajoute rien à une date illisible", () => {
    const now = "2026-10-20T08:00:00Z";
    const cases: [string, string][] = [
      ["2026-10-20", "le jour (aujourd’hui)"],
      ["2026-10-21", "le jour (demain)"],
      ["2026-10-22", "le jour"],
      ["2026-10-19", "le jour"],
      ["demain", "le jour"],
      ["", "le jour"],
    ];
    for (const [dayKey, text] of cases) {
      expect(renderedAt(now, dayKey)).toBe(text);
      cleanup();
    }
    // Fin d'année : le 31 décembre au soir, le 1er janvier est « demain ».
    expect(renderedAt("2026-12-31T08:00:00Z", "2027-01-01")).toBe("le jour (demain)");
  });
});
