import { describe, expect, it } from "vitest";
import { isProductionRuntime } from "./runtime-phase";

describe("isProductionRuntime", () => {
  it("est vrai en production à l'exécution (NEXT_PHASE absent ou autre que le build)", () => {
    expect(isProductionRuntime({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionRuntime({ NODE_ENV: "production", NEXT_PHASE: "" })).toBe(true);
    expect(
      isProductionRuntime({ NODE_ENV: "production", NEXT_PHASE: "phase-production-server" }),
    ).toBe(true);
  });

  it("est faux pendant next build, en développement et en test", () => {
    expect(
      isProductionRuntime({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }),
    ).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: "development" })).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: "test" })).toBe(false);
    expect(isProductionRuntime({})).toBe(false);
  });

  it("lit process.env par défaut", () => {
    const expected =
      process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";
    expect(isProductionRuntime()).toBe(expected);
  });
});
