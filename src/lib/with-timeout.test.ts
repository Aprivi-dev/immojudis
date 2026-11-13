import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@/lib/with-timeout";

afterEach(() => vi.useRealTimers());

describe("withTimeout", () => {
  it("rend le résultat de la promesse arrivée à temps", async () => {
    await expect(
      withTimeout(Promise.resolve(42), 1_000, () => new Error("trop long")),
    ).resolves.toBe(42);
  });

  it("lève l'erreur choisie par l'appelant au-delà du délai", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<never>(() => undefined), 500, () => new Error("délai"));
    vi.advanceTimersByTime(500);
    await expect(pending).rejects.toThrow("délai");
  });
});
