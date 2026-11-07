// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileActionBar } from "./MobileActionBar";

let notify: (isIntersecting: boolean, top?: number) => void = () => {};

beforeEach(() => {
  document.body.innerHTML = '<div data-hero-actions=""></div>';
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        callback: (
          entries: Array<{ isIntersecting: boolean; boundingClientRect: { top: number } }>,
        ) => void,
      ) {
        // Par défaut, les boutons sortent par le haut (le lecteur les a dépassés).
        notify = (isIntersecting, top = isIntersecting ? 100 : -300) =>
          callback([{ isIntersecting, boundingClientRect: { top } }]);
      }
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function hideHeroActions() {
  act(() => notify(false));
}

describe("MobileActionBar", () => {
  it("rappelle le plafond et la mise à prix quand les boutons du haut sont sortis de l'écran", () => {
    render(
      <MobileActionBar
        priceLabel="Mise à prix"
        price={90_000}
        ceiling={128_000}
        action={{ href: "#calculation", label: "Préparer mon enchère" }}
      />,
    );
    expect(screen.queryByTestId("mobile-action-bar")).toBeNull();
    // Boutons encore sous l'écran (pas atteints) : la synthèse n'est pas passée, pas de barre (n° 43).
    act(() => notify(false, 1200));
    expect(screen.queryByTestId("mobile-action-bar")).toBeNull();

    hideHeroActions();
    const bar = screen.getByTestId("mobile-action-bar");
    expect(bar.textContent).toContain("Plafond");
    expect(bar.textContent).toContain("128");
    expect(bar.textContent).toContain("Mise à prix");
    expect(bar.textContent).toContain("90");
    expect(screen.getByRole("link", { name: "Préparer mon enchère" })).toBeTruthy();
  });

  it("reste sur l'onglet du calcul, sans bouton, avec les deux montants", () => {
    render(
      <MobileActionBar priceLabel="Mise à prix" price={90_000} ceiling={128_000} action={null} />,
    );
    hideHeroActions();
    const bar = screen.getByTestId("mobile-action-bar");
    expect(bar.textContent).toContain("Plafond");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("ne montre rien sans action ni plafond", () => {
    render(<MobileActionBar priceLabel="Mise à prix" price={90_000} action={null} />);
    hideHeroActions();
    expect(screen.queryByTestId("mobile-action-bar")).toBeNull();
  });

  it("n'annonce pas de plafond quand il n'y en a pas", () => {
    render(
      <MobileActionBar
        priceLabel="Mise à prix"
        price={90_000}
        action={{ href: "#rendez-vous", label: "Préparer ma démarche" }}
      />,
    );
    hideHeroActions();
    expect(screen.getByTestId("mobile-action-bar").textContent).not.toContain("Plafond");
  });

  it("Analyse : « plafond · Mon dossier », le bouton ouvre le dossier de travail", () => {
    const onOpen = vi.fn();
    render(
      <MobileActionBar
        priceLabel="Mise à prix"
        price={90_000}
        ceiling={128_000}
        action={{ href: "#calculation", label: "Préparer mon enchère" }}
        dossier={{ caption: "votre plafond · 27 nov. 2026", onOpen }}
      />,
    );
    hideHeroActions();
    const bar = screen.getByTestId("mobile-action-bar");
    expect(bar.textContent).toMatch(/128.000\s€votre plafond · 27 nov. 2026/);
    expect(screen.queryByRole("link", { name: "Préparer mon enchère" })).toBeNull();
    screen.getByRole("button", { name: "Mon dossier" }).click();
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("barre du bas alignée sur la fiche visiteur (repasse n° 43)", () => {
  it("garde 72 px de haut et laisse la place au panneau collant à partir de 1024 px", async () => {
    const { readFileSync } = await import("node:fs");
    const overview = readFileSync("src/components/sale-detail/SaleOverview.module.css", "utf8");
    const visitor = readFileSync("src/components/SalePublicPreview.module.css", "utf8");
    expect(overview).toContain("min-height: calc(72px + env(safe-area-inset-bottom, 0px));");
    expect(visitor).toContain("min-height: calc(72px + env(safe-area-inset-bottom, 0px));");
    expect(overview).toMatch(/@media \(min-width: 1024px\) \{\s*\.mobileBar \{\s*display: none;/);
    expect(overview).not.toContain("@media (min-width: 960px)");
    render(<MobileActionBar priceLabel="Mise à prix" price={90_000} action={null} ceiling={1} />);
    hideHeroActions();
    expect(document.querySelector(".min-\\[1024px\\]\\:hidden")).not.toBeNull();
  });
});
