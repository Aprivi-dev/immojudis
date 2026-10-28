// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCountTo } from "./use-count-to";
import { useDemoLoop } from "./use-demo-loop";

function stubReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: reduced,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  stubReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const options = { steps: 3, firstMs: 4_000, stepMs: 3_000 };

describe("useDemoLoop", () => {
  it("fait un seul tour puis s'arrête sur la dernière étape", () => {
    const { result } = renderHook(() => useDemoLoop(options));
    expect(result.current.step).toBe(0);
    act(() => vi.advanceTimersByTime(3_999));
    expect(result.current.step).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.step).toBe(1);
    act(() => vi.advanceTimersByTime(3_000));
    expect(result.current.step).toBe(2);
    expect(result.current.running).toBe(false);
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.step).toBe(2);
  });

  it("attend au survol et au focus, puis reprend", () => {
    const { result } = renderHook(() => useDemoLoop(options));
    act(() => result.current.handlers.onMouseEnter());
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.step).toBe(0);
    act(() => result.current.handlers.onMouseLeave());
    act(() => result.current.handlers.onFocus());
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.step).toBe(0);
    act(() =>
      result.current.handlers.onBlur({
        currentTarget: document.createElement("div"),
        relatedTarget: null,
      } as never),
    );
    act(() => vi.advanceTimersByTime(4_000));
    expect(result.current.step).toBe(1);
  });

  it("s'arrête pour de bon au toucher, au choix, et se met en pause sur demande", () => {
    const touched = renderHook(() => useDemoLoop(options));
    act(() => touched.result.current.handlers.onTouchStart());
    act(() => vi.advanceTimersByTime(30_000));
    expect(touched.result.current.step).toBe(0);
    expect(touched.result.current.stopped).toBe(true);

    const paused = renderHook(() => useDemoLoop(options));
    act(() => paused.result.current.togglePause());
    expect(paused.result.current.paused).toBe(true);
    act(() => vi.advanceTimersByTime(30_000));
    expect(paused.result.current.step).toBe(0);
    act(() => paused.result.current.togglePause());
    act(() => vi.advanceTimersByTime(4_000));
    expect(paused.result.current.step).toBe(1);
  });

  it("ne démarre pas tant que la zone n'est pas à l'écran", () => {
    const { result, rerender } = renderHook(({ active }) => useDemoLoop({ ...options, active }), {
      initialProps: { active: false },
    });
    act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.step).toBe(0);
    rerender({ active: true });
    act(() => vi.advanceTimersByTime(4_000));
    expect(result.current.step).toBe(1);
  });

  it("ne défile pas quand les animations sont réduites", () => {
    stubReducedMotion(true);
    const { result } = renderHook(() => useDemoLoop(options));
    act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.step).toBe(0);
    expect(result.current.running).toBe(false);
  });

  it("s'arrête quand un élément de la zone reçoit le focus (événement React)", () => {
    function Zone() {
      const loop = useDemoLoop(options);
      return (
        <div {...loop.handlers}>
          <button type="button">Réglage</button>
          <output data-testid="step">{loop.step}</output>
        </div>
      );
    }
    const { getByRole, getByTestId } = render(<Zone />);
    fireEvent.focus(getByRole("button"));
    act(() => vi.advanceTimersByTime(30_000));
    expect(getByTestId("step").textContent).toBe("0");
  });
});

describe("useCountTo", () => {
  it("repart de la valeur affichée quand la cible change en cours d'animation", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) =>
      setTimeout(() => callback(now), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const tick = (ms: number) =>
      act(() => {
        now += ms;
        vi.advanceTimersByTime(ms);
      });

    const { result, rerender } = renderHook(({ target }) => useCountTo(target), {
      initialProps: { target: 100_000 },
    });
    rerender({ target: 200_000 });
    tick(350);
    const midway = result.current;
    expect(midway).toBeGreaterThan(100_000);
    expect(midway).toBeLessThan(200_000);

    // Nouvelle cible avant la fin : la première image part de la valeur affichée, pas de 200 000.
    rerender({ target: 150_000 });
    tick(16);
    expect(Math.abs(result.current - midway)).toBeLessThan(10_000);
    tick(1_000);
    expect(result.current).toBe(150_000);
  });
});
