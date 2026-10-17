// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAfterNextPaint, useFirstGestureStart } from "./use-first-gesture-start";

/**
 * Les trois files d'attente du navigateur, pilotées à la main : image suivante, moment
 * d'inactivité, `setTimeout`. Le test voit ainsi dans quel ordre, et pas seulement si, le
 * démarrage a lieu.
 */
function installScheduler({ idle }: { idle: boolean }) {
  const frames = new Map<number, FrameRequestCallback>();
  const idles = new Map<number, IdleRequestCallback>();
  const idleOptions: Array<IdleRequestOptions | undefined> = [];
  let nextId = 1;

  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(nextId, callback);
    return nextId++;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  if (idle) {
    window.requestIdleCallback = ((callback: IdleRequestCallback, options?: IdleRequestOptions) => {
      idles.set(nextId, callback);
      idleOptions.push(options);
      return nextId++;
    }) as typeof window.requestIdleCallback;
    window.cancelIdleCallback = ((id: number) => {
      idles.delete(id);
    }) as typeof window.cancelIdleCallback;
  }

  return {
    pending: () => ({ frames: frames.size, idles: idles.size }),
    idleOptions,
    runFrames() {
      const callbacks = [...frames.values()];
      frames.clear();
      act(() => callbacks.forEach((callback) => callback(0)));
    },
    runIdles() {
      const callbacks = [...idles.values()];
      idles.clear();
      act(() =>
        callbacks.forEach((callback) =>
          callback({ didTimeout: false, timeRemaining: () => 10 } as IdleDeadline),
        ),
      );
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "requestIdleCallback");
  Reflect.deleteProperty(window, "cancelIdleCallback");
});

describe("useFirstGestureStart", () => {
  it("ne fait rien tant qu'il est désactivé", () => {
    const scheduler = installScheduler({ idle: true });
    const onStart = vi.fn();
    renderHook(() => useFirstGestureStart({ enabled: false, onStart }));
    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    scheduler.runFrames();
    scheduler.runIdles();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("ne démarre jamais sans geste, même longtemps après (ni minuteur ni inactivité)", () => {
    const scheduler = installScheduler({ idle: true });
    const onStart = vi.fn();
    renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    scheduler.runFrames();
    scheduler.runIdles();
    expect(onStart).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pointerdown", "wheel", "touchstart"])(
    "démarre au premier %s, une seule fois",
    (eventName) => {
      const scheduler = installScheduler({ idle: true });
      const onStart = vi.fn();
      renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
      act(() => {
        window.dispatchEvent(new Event(eventName));
        window.dispatchEvent(new Event("pointerdown"));
        window.dispatchEvent(new Event("wheel"));
      });
      scheduler.runFrames();
      scheduler.runIdles();
      expect(onStart).toHaveBeenCalledTimes(1);
    },
  );

  it("ne démarre pas la carte à une touche, Tab compris (le bouton reste le moyen au clavier)", () => {
    const scheduler = installScheduler({ idle: true });
    const onStart = vi.fn();
    renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      window.dispatchEvent(new Event("focusin"));
    });
    scheduler.runFrames();
    scheduler.runIdles();
    expect(onStart).not.toHaveBeenCalled();
    expect(scheduler.pending()).toEqual({ frames: 0, idles: 0 });
  });

  it("ignore les événements qui ne sont pas un geste (déplacement de souris, défilement)", () => {
    const scheduler = installScheduler({ idle: true });
    const onStart = vi.fn();
    renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
    act(() => {
      window.dispatchEvent(new Event("pointermove"));
      window.dispatchEvent(new Event("mousemove"));
      window.dispatchEvent(new Event("scroll"));
    });
    scheduler.runFrames();
    scheduler.runIdles();
    expect(onStart).not.toHaveBeenCalled();
  });

  describe("démarrage différé après la peinture du geste", () => {
    it("attend l'image suivante, puis un moment d'inactivité : jamais dans le geste lui-même", () => {
      const scheduler = installScheduler({ idle: true });
      const onStart = vi.fn();
      renderHook(() => useFirstGestureStart({ enabled: true, onStart }));

      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      expect(onStart).not.toHaveBeenCalled();
      expect(scheduler.pending()).toEqual({ frames: 1, idles: 0 });

      scheduler.runFrames();
      expect(onStart).not.toHaveBeenCalled();
      expect(scheduler.pending()).toEqual({ frames: 0, idles: 1 });
      // Un navigateur occupé ne repousse pas le démarrage indéfiniment.
      expect(scheduler.idleOptions).toEqual([{ timeout: 500 }]);

      scheduler.runIdles();
      expect(onStart).toHaveBeenCalledTimes(1);
    });

    it("replie sur setTimeout(0) après l'image quand requestIdleCallback n'existe pas (Safari)", () => {
      const scheduler = installScheduler({ idle: false });
      const onStart = vi.fn();
      renderHook(() => useFirstGestureStart({ enabled: true, onStart }));

      act(() => {
        window.dispatchEvent(new Event("wheel"));
      });
      expect(onStart).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      scheduler.runFrames();
      expect(onStart).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      act(() => {
        vi.advanceTimersByTime(0);
      });
      expect(onStart).toHaveBeenCalledTimes(1);
    });

    it("annule le démarrage en attente quand le hook est désactivé (le bouton a démarré la carte)", () => {
      const scheduler = installScheduler({ idle: true });
      const onStart = vi.fn();
      const { rerender } = renderHook(({ enabled }) => useFirstGestureStart({ enabled, onStart }), {
        initialProps: { enabled: true },
      });
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      scheduler.runFrames();
      expect(scheduler.pending().idles).toBe(1);

      rerender({ enabled: false });
      expect(scheduler.pending()).toEqual({ frames: 0, idles: 0 });
      scheduler.runIdles();
      expect(onStart).not.toHaveBeenCalled();
    });

    it("annule le démarrage en attente au démontage, avant comme après l'image", () => {
      const scheduler = installScheduler({ idle: false });
      const onStart = vi.fn();
      const first = renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      first.unmount();
      expect(scheduler.pending().frames).toBe(0);

      const second = renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
      act(() => {
        window.dispatchEvent(new Event("pointerdown"));
      });
      scheduler.runFrames();
      expect(vi.getTimerCount()).toBe(1);
      second.unmount();
      expect(vi.getTimerCount()).toBe(0);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(onStart).not.toHaveBeenCalled();
    });
  });

  describe("bouton « Afficher la carte »", () => {
    function button() {
      const element = document.createElement("button");
      element.setAttribute("data-map-explicit-start", "");
      const icon = document.createElement("span");
      element.append(icon);
      document.body.append(element);
      return { element, icon };
    }

    afterEach(() => {
      document.body.innerHTML = "";
    });

    it("ignore l'appui et le toucher sur le bouton : il démarre la carte lui-même, tout de suite", () => {
      const scheduler = installScheduler({ idle: true });
      const onStart = vi.fn();
      renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
      const { element, icon } = button();
      act(() => {
        icon.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        element.dispatchEvent(new Event("touchstart", { bubbles: true }));
      });
      expect(scheduler.pending()).toEqual({ frames: 0, idles: 0 });
      scheduler.runFrames();
      scheduler.runIdles();
      expect(onStart).not.toHaveBeenCalled();
    });

    it("écoute encore le geste suivant, et la molette sur le bouton compte", () => {
      const scheduler = installScheduler({ idle: true });
      const onStart = vi.fn();
      renderHook(() => useFirstGestureStart({ enabled: true, onStart }));
      const { element } = button();
      act(() => {
        element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        element.dispatchEvent(new Event("wheel", { bubbles: true }));
      });
      scheduler.runFrames();
      scheduler.runIdles();
      expect(onStart).toHaveBeenCalledTimes(1);
    });
  });

  it("n'écoute plus une fois désactivé et n'appelle rien après le démontage", () => {
    const scheduler = installScheduler({ idle: true });
    const onStart = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useFirstGestureStart({ enabled, onStart }),
      { initialProps: { enabled: true } },
    );
    rerender({ enabled: false });
    act(() => {
      window.dispatchEvent(new Event("pointerdown"));
    });
    scheduler.runFrames();
    scheduler.runIdles();
    expect(onStart).not.toHaveBeenCalled();

    rerender({ enabled: true });
    unmount();
    act(() => {
      window.dispatchEvent(new Event("wheel"));
    });
    scheduler.runFrames();
    scheduler.runIdles();
    expect(onStart).not.toHaveBeenCalled();
  });
});

describe("runAfterNextPaint", () => {
  it("renvoie une fonction qui annule le rappel, avant l'image comme pendant l'attente", () => {
    const scheduler = installScheduler({ idle: true });
    const callback = vi.fn();

    runAfterNextPaint(callback)();
    scheduler.runFrames();
    scheduler.runIdles();
    expect(callback).not.toHaveBeenCalled();

    const cancel = runAfterNextPaint(callback);
    scheduler.runFrames();
    cancel();
    scheduler.runIdles();
    expect(callback).not.toHaveBeenCalled();

    runAfterNextPaint(callback);
    scheduler.runFrames();
    scheduler.runIdles();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
