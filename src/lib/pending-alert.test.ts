// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PENDING_ALERT_STORAGE_KEY,
  PENDING_ALERT_TTL_MS,
  clearPendingAlert,
  peekPendingAlert,
  savePendingAlert,
  takePendingAlert,
} from "./pending-alert";

const NOW = Date.UTC(2026, 9, 23, 10, 0, 0);

beforeEach(() => window.localStorage.clear());
afterEach(() => window.localStorage.clear());

describe("alerte en attente", () => {
  it("garde les critères et le choix d'email récapitulatif, et les rend validés", () => {
    savePendingAlert(
      { department: "33", homeTypes: ["house"], maxPrice: 150000, belowRange: true },
      { emailRecap: true, frequency: "weekly", name: "Gironde" },
      NOW,
    );
    expect(peekPendingAlert(NOW + 1000)).toEqual({
      search: expect.objectContaining({
        department: "33",
        homeTypes: ["house"],
        maxPrice: 150000,
        belowRange: true,
      }),
      options: { emailRecap: true, frequency: "weekly", name: "Gironde" },
    });
  });

  it("ne garde aucune donnée personnelle : seulement les critères et le choix d'email", () => {
    savePendingAlert({ department: "33" }, { emailRecap: true }, NOW);
    const raw = window.localStorage.getItem(PENDING_ALERT_STORAGE_KEY) ?? "";
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["options", "savedAt", "search"]);
    expect(raw).not.toMatch(/@|user|email":/);
  });

  it("ne sert qu'une fois", () => {
    savePendingAlert({ department: "33" }, {}, NOW);
    expect(takePendingAlert(NOW)).not.toBeNull();
    expect(takePendingAlert(NOW)).toBeNull();
    expect(peekPendingAlert(NOW)).toBeNull();
  });

  it("expire au bout de 24 heures et s'efface", () => {
    savePendingAlert({ department: "33" }, {}, NOW);
    expect(peekPendingAlert(NOW + PENDING_ALERT_TTL_MS)).not.toBeNull();
    expect(peekPendingAlert(NOW + PENDING_ALERT_TTL_MS + 1)).toBeNull();
    expect(window.localStorage.getItem(PENDING_ALERT_STORAGE_KEY)).toBeNull();
  });

  it("efface une trace illisible ou falsifiée", () => {
    for (const raw of ["pas du json", "[]", '{"savedAt":"hier","search":{}}', '{"savedAt":1}']) {
      window.localStorage.setItem(PENDING_ALERT_STORAGE_KEY, raw);
      expect(peekPendingAlert(NOW)).toBeNull();
      expect(window.localStorage.getItem(PENDING_ALERT_STORAGE_KEY)).toBeNull();
    }
  });

  it("ignore une fréquence inconnue et ne rend que des critères validés", () => {
    window.localStorage.setItem(
      PENDING_ALERT_STORAGE_KEY,
      JSON.stringify({
        savedAt: NOW,
        search: { department: "33", maxPrice: "abc", page: -4 },
        options: { frequency: "hourly", emailRecap: "oui" },
      }),
    );
    const pending = peekPendingAlert(NOW);
    expect(pending?.options).toEqual({});
    expect(pending?.search.department).toBe("33");
    expect(pending?.search.maxPrice).toBeUndefined();
  });

  it("clearPendingAlert supprime la demande", () => {
    savePendingAlert({ department: "33" }, {}, NOW);
    clearPendingAlert();
    expect(peekPendingAlert(NOW)).toBeNull();
  });
});
