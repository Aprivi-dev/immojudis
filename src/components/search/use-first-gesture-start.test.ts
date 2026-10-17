// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFirstGestureStart } from "./use-first-gesture-start";

describe("useFirstGestureStart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("ne fait rien tant qu'il est désactivé", () => {
    const onStart = vi.fn();
    renderHook(() => useFirstGestureStart({ enabled: false, onStart }));
    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("ne démarre jamais sans geste, même longtemps après (ni minuteur ni inactivité)", () => {
    const onStart = vi.fn();
    window.requestIdleCallback = ((callback: () => void) => {
      callback();
      return 1;
    }) as typeof window.requestIdleCallback;
    renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    Reflect.deleteProperty(window, "requestIdleCallback");
    expect(onStart).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pointerdown", "keydown", "wheel", "touchstart"])(
    "démarre au premier %s, une seule fois",
    (eventName) => {
      const onStart = vi.fn();
      renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
      act(() => {
        window.dispatchEvent(new Event(eventName));
        window.dispatchEvent(new Event("pointerdown"));
        window.dispatchEvent(new Event("keydown"));
      });
      expect(onStart).toHaveBeenCalledTimes(1);
    },
  );

  it("ignore les événements qui ne sont pas un geste (déplacement de souris, défilement)", () => {
    const onStart = vi.fn();
    renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
    act(() => {
      window.dispatchEvent(new Event("pointermove"));
      window.dispatchEvent(new Event("mousemove"));
      window.dispatchEvent(new Event("scroll"));
    });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("n'écoute plus une fois désactivé et n'appelle rien après le démontage", () => {
    const onStart = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useFirstGestureStart({ enabled, onStart }),
      { initialProps: { enabled: true } },
    );
    rerender({ enabled: false });
    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    expect(onStart).not.toHaveBeenCalled();

    rerender({ enabled: true });
    unmount();
    act(() => {
      window.dispatchEvent(new Event("keydown"));
    });
    expect(onStart).not.toHaveBeenCalled();
  });
});
