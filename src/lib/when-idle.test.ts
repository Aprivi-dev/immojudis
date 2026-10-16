// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { whenIdle } from "./when-idle";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("whenIdle", () => {
  it("utilise requestIdleCallback avec le délai maximal demandé et sait annuler", () => {
    const request = vi.fn().mockReturnValue(7);
    const cancel = vi.fn();
    vi.stubGlobal("requestIdleCallback", request);
    vi.stubGlobal("cancelIdleCallback", cancel);
    const callback = vi.fn();

    const stop = whenIdle(callback, 1_500);
    expect(request).toHaveBeenCalledWith(callback, { timeout: 1_500 });
    stop();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("se rabat sur un délai court sans requestIdleCallback (Safari)", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const callback = vi.fn();

    whenIdle(callback);
    vi.advanceTimersByTime(499);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("n'exécute pas la fonction une fois annulé", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const callback = vi.fn();

    whenIdle(callback)();
    vi.advanceTimersByTime(5_000);
    expect(callback).not.toHaveBeenCalled();
  });
});
