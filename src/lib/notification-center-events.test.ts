// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isDesktopHeader,
  onOpenNotificationsRequest,
  requestOpenNotifications,
} from "./notification-center-events";

afterEach(() => vi.unstubAllGlobals());

describe("demande d'ouverture de la cloche", () => {
  it("prévient les écouteurs, jusqu'à ce qu'ils se retirent", () => {
    const listener = vi.fn();
    const stop = onOpenNotificationsRequest(listener);
    requestOpenNotifications();
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    requestOpenNotifications();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("considère la barre d'en-tête affichée à partir de 1024 px, ou sans matchMedia", () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(min-width: 1024px)" }));
    vi.stubGlobal("matchMedia", matchMedia);
    expect(isDesktopHeader()).toBe(true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(isDesktopHeader()).toBe(false);
    vi.stubGlobal("matchMedia", undefined);
    expect(isDesktopHeader()).toBe(true);
  });
});
