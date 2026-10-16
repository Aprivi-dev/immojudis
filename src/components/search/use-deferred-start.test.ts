// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFERRED_START_FALLBACK_MS,
  DEFERRED_START_MAX_WAIT_MS,
  useDeferredStart,
} from "./use-deferred-start";

describe("useDeferredStart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "requestIdleCallback");
    Reflect.deleteProperty(window, "cancelIdleCallback");
  });

  it("ne fait rien tant qu'il est désactivé", () => {
    const onStart = vi.fn();
    renderHook(() => useDeferredStart({ enabled: false, listReady: true, onStart }));
    act(() => {
      vi.advanceTimersByTime(DEFERRED_START_MAX_WAIT_MS * 2);
      window.dispatchEvent(new Event("pointerdown"));
    });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("attend l'affichage de la liste, puis démarre après un court délai (repli sans idle)", () => {
    const onStart = vi.fn();
    const { rerender } = renderHook(
      ({ listReady }) => useDeferredStart({ enabled: true, listReady, onStart }),
      { initialProps: { listReady: false } },
    );
    act(() => {
      vi.advanceTimersByTime(DEFERRED_START_FALLBACK_MS * 3);
    });
    expect(onStart).not.toHaveBeenCalled();

    rerender({ listReady: true });
    act(() => {
      vi.advanceTimersByTime(DEFERRED_START_FALLBACK_MS - 1);
    });
    expect(onStart).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("utilise requestIdleCallback quand il existe", () => {
    const onStart = vi.fn();
    let idleCallback: (() => void) | null = null;
    window.requestIdleCallback = ((callback: () => void) => {
      idleCallback = callback;
      return 7;
    }) as typeof window.requestIdleCallback;
    window.cancelIdleCallback = vi.fn();

    renderHook(() => useDeferredStart({ enabled: true, listReady: true, onStart }));
    act(() => {
      vi.advanceTimersByTime(DEFERRED_START_FALLBACK_MS * 2);
    });
    expect(onStart).not.toHaveBeenCalled();

    act(() => idleCallback?.());
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("démarre au premier geste, avant que la liste soit prête, une seule fois", () => {
    const onStart = vi.fn();
    renderHook(() => useDeferredStart({ enabled: true, listReady: false, onStart }));
    act(() => {
      window.dispatchEvent(new Event("keydown"));
      window.dispatchEvent(new Event("pointerdown"));
      vi.advanceTimersByTime(DEFERRED_START_MAX_WAIT_MS * 2);
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("démarre au plus tard au plafond, même si la liste n'est jamais prête", () => {
    const onStart = vi.fn();
    renderHook(() => useDeferredStart({ enabled: true, listReady: false, onStart }));
    act(() => {
      vi.advanceTimersByTime(DEFERRED_START_MAX_WAIT_MS);
    });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("n'appelle rien après le démontage", () => {
    const onStart = vi.fn();
    const { unmount } = renderHook(() =>
      useDeferredStart({ enabled: true, listReady: true, onStart }),
    );
    unmount();
    act(() => {
      vi.advanceTimersByTime(DEFERRED_START_MAX_WAIT_MS * 2);
      window.dispatchEvent(new Event("pointerdown"));
    });
    expect(onStart).not.toHaveBeenCalled();
  });
});
