// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SalePublicMobileBar } from "./SalePublicMobileBar";

/** La hauteur de la barre, plus celle du bandeau des cookies quand il est affiché (P3). */
const BAR_SCROLL_PADDING = "calc(88px + var(--cookie-banner-height, 0px))";

type Callback = (
  entries: Array<{ isIntersecting: boolean; boundingClientRect: { top: number } }>,
) => void;

function mockIntersectionObserver() {
  const observers: { callback: Callback; target: Element | null }[] = [];
  class FakeObserver {
    callback: Callback;
    constructor(callback: Callback) {
      this.callback = callback;
      observers.push({ callback, target: null });
    }
    observe(target: Element) {
      observers[observers.length - 1].target = target;
    }
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  return observers;
}

function renderBar() {
  return render(
    <>
      <aside aria-label="Synthèse de la vente" data-sale-synthesis>
        Créer mon compte gratuit
      </aside>
      <SalePublicMobileBar className="bar">
        <a href="/login">Créer mon compte</a>
      </SalePublicMobileBar>
    </>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.style.scrollPaddingBottom = "";
});

describe("barre du bas de la fiche visiteur", () => {
  it("n'apparaît qu'une fois la synthèse sortie de l'écran (n° 43)", () => {
    const observers = mockIntersectionObserver();
    renderBar();
    // La synthèse est à l'écran au chargement : pas de barre qui la répète.
    expect(screen.queryByTestId("public-mobile-bar")).toBeNull();
    expect(observers[0].target?.getAttribute("aria-label")).toBe("Synthèse de la vente");

    act(() => observers[0].callback([{ isIntersecting: true, boundingClientRect: { top: 200 } }]));
    expect(screen.queryByTestId("public-mobile-bar")).toBeNull();
    // Encore sous l'écran (pas atteinte) : toujours pas de barre.
    act(() =>
      observers[0].callback([{ isIntersecting: false, boundingClientRect: { top: 1200 } }]),
    );
    expect(screen.queryByTestId("public-mobile-bar")).toBeNull();

    act(() =>
      observers[0].callback([{ isIntersecting: false, boundingClientRect: { top: -400 } }]),
    );
    const bar = screen.getByTestId("public-mobile-bar");
    expect(bar.className).toBe("bar");
    expect(screen.getByRole("link", { name: "Créer mon compte" })).toBeTruthy();

    act(() => observers[0].callback([{ isIntersecting: true, boundingClientRect: { top: 200 } }]));
    expect(screen.queryByTestId("public-mobile-bar")).toBeNull();
  });

  it("réserve sa hauteur au défilement : le focus ne passe pas dessous (n° 8)", () => {
    const observers = mockIntersectionObserver();
    document.documentElement.style.scrollPaddingBottom = "12px";
    const { unmount } = renderBar();
    expect(document.documentElement.style.scrollPaddingBottom).toBe("12px");

    act(() =>
      observers[0].callback([{ isIntersecting: false, boundingClientRect: { top: -400 } }]),
    );
    expect(document.documentElement.style.scrollPaddingBottom).toBe(BAR_SCROLL_PADDING);

    act(() => observers[0].callback([{ isIntersecting: true, boundingClientRect: { top: 200 } }]));
    expect(document.documentElement.style.scrollPaddingBottom).toBe("12px");

    act(() =>
      observers[0].callback([{ isIntersecting: false, boundingClientRect: { top: -400 } }]),
    );
    unmount();
    expect(document.documentElement.style.scrollPaddingBottom).toBe("12px");
  });

  it("reste affichée sans IntersectionObserver (navigateur ancien)", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    renderBar();
    expect(screen.getByTestId("public-mobile-bar")).toBeTruthy();
    expect(document.documentElement.style.scrollPaddingBottom).toBe(BAR_SCROLL_PADDING);
  });
});
