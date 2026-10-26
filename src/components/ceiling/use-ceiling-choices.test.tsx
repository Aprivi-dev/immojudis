// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorksBreakdownItem } from "@/lib/works-breakdown";
import {
  ceilingStorageKey,
  choicesWithoutWorksBreakdown,
  parseCeilingChoices,
  useCeilingChoices,
} from "./use-ceiling-choices";

const breakdown: WorksBreakdownItem[] = [
  { id: "a", kind: "toiture", label: "", quantity: "1", unit: "forfait", unitCost: "8000" },
  { id: "b", kind: "autre", label: "Portail", quantity: "2", unit: "u", unitCost: "450,5" },
];

function installLocalStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
}

beforeEach(installLocalStorage);
afterEach(cleanup);

describe("parseCeilingChoices", () => {
  it("restores the notarial fees the user read in the conditions of the sale", () => {
    expect(
      parseCeilingChoices({
        consignation: 12_000,
        negotiationFeeRatePct: 4.5,
        advertisingFees: 1_200,
        // A negative or non-numeric stored value is dropped, like every other number field.
        lawyerFees: -1,
      }),
    ).toEqual({ consignation: 12_000, negotiationFeeRatePct: 4.5, advertisingFees: 1_200 });
    expect(parseCeilingChoices({ negotiationFeeRatePct: "4,5" })).toEqual({});
  });

  it("restores the works breakdown next to the other choices", () => {
    const choices = parseCeilingChoices({
      project: "louer",
      works: { key: "devis", amount: 8_900 },
      worksBreakdown: breakdown,
    });

    expect(choices.project).toBe("louer");
    expect(choices.works).toEqual({ key: "devis", amount: 8_900, months: null });
    expect(choices.worksBreakdown).toEqual(breakdown);
  });

  it("ignores a stored breakdown that is not a list of postes", () => {
    expect(parseCeilingChoices({ worksBreakdown: "abc" })).toEqual({});
    expect(parseCeilingChoices({ worksBreakdown: [] })).toEqual({});
    expect(parseCeilingChoices({ worksBreakdown: [{ kind: "toiture", unitCost: 9 }] })).toEqual({
      worksBreakdown: [
        { id: "poste-0", kind: "toiture", label: "", quantity: "", unit: "", unitCost: "" },
      ],
    });
  });

  it("keeps a breakdown out of the choices sent with a saved report", () => {
    const withBreakdown = parseCeilingChoices({
      project: "habiter",
      works: { key: "devis", amount: 100 },
      worksBreakdown: breakdown,
    });

    const sent = choicesWithoutWorksBreakdown(withBreakdown);

    expect("worksBreakdown" in sent).toBe(false);
    expect(sent).toEqual({
      project: "habiter",
      works: { key: "devis", amount: 100, months: null },
    });
    // The caller's own choices are untouched.
    expect(withBreakdown.worksBreakdown).toHaveLength(2);
  });
});

describe("useCeilingChoices with a works breakdown", () => {
  it("saves the breakdown where the calculator saves its hypotheses, and restores it", () => {
    const first = renderHook(() => useCeilingChoices("account-a", "sale-1"));
    act(() =>
      first.result.current.update((choices) => ({ ...choices, worksBreakdown: breakdown })),
    );

    const stored = JSON.parse(
      window.localStorage.getItem(ceilingStorageKey("account-a", "sale-1")) ?? "null",
    );
    expect(stored.worksBreakdown).toEqual(breakdown);
    first.unmount();

    const second = renderHook(() => useCeilingChoices("account-a", "sale-1"));
    expect(second.result.current.choices.worksBreakdown).toEqual(breakdown);
  });

  it("does not share the breakdown between sales or between accounts", () => {
    const first = renderHook(() => useCeilingChoices("account-a", "sale-1"));
    act(() =>
      first.result.current.update((choices) => ({ ...choices, worksBreakdown: breakdown })),
    );
    first.unmount();

    expect(
      renderHook(() => useCeilingChoices("account-a", "sale-2")).result.current.choices,
    ).toEqual({});
    expect(
      renderHook(() => useCeilingChoices("account-b", "sale-1")).result.current.choices,
    ).toEqual({});
  });

  it("keeps the budget and its breakdown when the hypotheses are reset", () => {
    const hook = renderHook(() => useCeilingChoices("account-a", "sale-1"));
    act(() =>
      hook.result.current.update((choices) => ({
        ...choices,
        project: "revendre",
        works: { key: "devis", amount: 8_900 },
        worksBreakdown: breakdown,
      })),
    );

    act(() => hook.result.current.reset());

    expect(hook.result.current.choices).toEqual({
      works: { key: "devis", amount: 8_900 },
      worksBreakdown: breakdown,
    });
  });
});
