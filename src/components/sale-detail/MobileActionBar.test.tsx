// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileActionBar } from "./MobileActionBar";

let notify: (isIntersecting: boolean) => void = () => {};

beforeEach(() => {
  document.body.innerHTML = '<div data-hero-actions=""></div>';
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) {
        notify = (isIntersecting) => callback([{ isIntersecting }]);
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
});
