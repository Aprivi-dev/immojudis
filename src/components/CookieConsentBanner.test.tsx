// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAnalyticsConsent } from "@/lib/analytics-consent";
import { setAudienceOptOut } from "@/lib/audience-opt-out";
import { CookieConsentBanner } from "./CookieConsentBanner";

let resizeCallbacks: Array<() => void> = [];

class ResizeObserverStub {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  disconnect() {}
}

function stubBannerLayout(position: "fixed" | "static", height: number) {
  const realComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = realComputedStyle(element, pseudo);
    if (element instanceof HTMLElement && element.dataset.testid === "cookie-consent-banner") {
      return { ...style, position } as CSSStyleDeclaration;
    }
    return style;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    height,
  } as DOMRect);
}

beforeEach(() => {
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  window.localStorage.clear();
  setAudienceOptOut(false);
  document.body.innerHTML = "";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CookieConsentBanner : accessibilité et mise en page", () => {
  it("réserve sa hauteur tant qu'il est affiché en bas de l'écran, puis la rend", () => {
    stubBannerLayout("fixed", 212.4);
    render(<CookieConsentBanner />);

    const root = document.documentElement;
    expect(root.style.scrollPaddingBottom).toBe("213px");
    expect(root.style.getPropertyValue("--cookie-banner-height")).toBe("213px");
    expect(document.body.style.paddingBottom).toBe("213px");

    // Le bandeau change de taille (texte replié, autre largeur) : la réserve suit.
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      height: 140,
    } as DOMRect);
    act(() => resizeCallbacks.forEach((callback) => callback()));
    expect(root.style.scrollPaddingBottom).toBe("140px");

    fireEvent.click(screen.getByRole("button", { name: "Refuser" }));
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
    expect(root.style.scrollPaddingBottom).toBe("");
    expect(root.style.getPropertyValue("--cookie-banner-height")).toBe("");
    expect(document.body.style.paddingBottom).toBe("");
  });

  it("ne réserve rien quand il reste dans le flux (écran peu haut)", () => {
    stubBannerLayout("static", 300);
    render(<CookieConsentBanner />);

    expect(document.documentElement.style.scrollPaddingBottom).toBe("");
    expect(document.documentElement.style.getPropertyValue("--cookie-banner-height")).toBe("0px");
    expect(document.body.style.paddingBottom).toBe("");
  });

  it("repasse en flux sous 30 rem de hauteur et se pose sur le contenu au-delà", () => {
    render(<CookieConsentBanner />);
    const className = screen.getByTestId("cookie-consent-banner").className;
    expect(className).toContain("fixed");
    expect(className).toContain("[@media(max-height:30rem)]:static");
  });

  it("rend le focus au contenu principal après le choix, au lieu de le perdre sur body", () => {
    render(
      <>
        <main>
          <h1>Contenu</h1>
        </main>
        <CookieConsentBanner />
      </>,
    );
    const accept = screen.getByRole("button", { name: "Accepter" });
    accept.focus();
    expect(document.activeElement).toBe(accept);

    fireEvent.click(accept);

    expect(readAnalyticsConsent()).toBe("granted");
    expect(screen.queryByTestId("cookie-consent-banner")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("main"));
    expect(document.querySelector("main")?.getAttribute("tabindex")).toBe("-1");
  });

  it("ne déplace pas le focus s'il n'était pas dans le bandeau", () => {
    render(
      <>
        <button type="button">Ailleurs</button>
        <main />
        <CookieConsentBanner />
      </>,
    );
    const elsewhere = screen.getByRole("button", { name: "Ailleurs" });
    elsewhere.focus();

    fireEvent.click(screen.getByRole("button", { name: "Refuser" }));

    expect(document.activeElement).toBe(elsewhere);
  });

  it("titre en police sans empattement du design system", () => {
    render(<CookieConsentBanner />);
    const heading = screen.getByRole("heading", { name: "Cookies de mesure d’audience" });
    expect(heading.className).toContain("font-sans");
  });
});
