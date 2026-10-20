// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: { active: true, pending: false },
  user: null as { id: string } | null,
}));
vi.mock("@/hooks/use-launch-offer", () => ({ useLaunchOffer: () => mocks.launch }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));

import { LAUNCH_OFFER_ACCOUNT_TEXT, LAUNCH_OFFER_VISITOR_TEXT } from "@/lib/launch-offer";
import { LaunchOfferListBanner } from "./LaunchOfferListBanner";

afterEach(() => {
  cleanup();
  mocks.launch = { active: true, pending: false };
  mocks.user = null;
});

describe("bannière de l'offre de lancement au-dessus de la liste", () => {
  it("porte le texte complet une seule fois, dans un bloc repliable, avec un lien vers /offres", () => {
    render(<LaunchOfferListBanner />);
    const banner = screen.getByTestId("launch-offer-list-banner");
    expect(banner.tagName).toBe("DETAILS");
    expect(banner.hasAttribute("open")).toBe(false);
    expect(banner.textContent).toContain(LAUNCH_OFFER_VISITOR_TEXT);
    expect(banner.textContent).toContain("retirables sans préavis");
    expect(screen.getByRole("link", { name: "Voir les offres" }).getAttribute("href")).toBe(
      "/offres",
    );
  });

  it("lit la mention du compte connecté", () => {
    mocks.user = { id: "user-1" };
    render(<LaunchOfferListBanner />);
    expect(screen.getByTestId("launch-offer-list-banner").textContent).toContain(
      LAUNCH_OFFER_ACCOUNT_TEXT,
    );
  });

  it("n'affiche rien quand l'offre est coupée", () => {
    mocks.launch = { active: false, pending: false };
    const { container } = render(<LaunchOfferListBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("réserve la hauteur sans rien dire tant que l'état est inconnu", () => {
    mocks.launch = { active: false, pending: true };
    const { container } = render(<LaunchOfferListBanner />);
    const placeholder = screen.getByTestId("launch-offer-list-banner-placeholder");
    expect(placeholder.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder.className).toContain("min-h-");
    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("launch-offer-list-banner")).toBeNull();
  });
});
