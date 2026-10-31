// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: { user: null as { id: string } | null, loading: false },
  track: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));
vi.mock("@/hooks/use-launch-offer", () => ({
  useLaunchOffer: () => ({ active: true, pending: false }),
}));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

import { HomeBrowseWithoutAccount, HomePrimaryAction } from "./HomePrimaryAction";

beforeEach(() => {
  mocks.auth = { user: null, loading: false };
  mocks.track.mockClear();
});
// jsdom n'implémente pas la navigation : on la neutralise.
const keepPage = (event: Event) => event.preventDefault();
beforeEach(() => document.addEventListener("click", keepPage));
afterEach(() => {
  document.removeEventListener("click", keepPage);
  cleanup();
});

describe("HomePrimaryAction", () => {
  it("mesure le clic sur « Créer mon compte gratuit » et sur le lien sans compte", () => {
    render(<HomePrimaryAction browseLink />);
    fireEvent.click(screen.getByRole("link", { name: /Créer mon compte gratuit/ }));
    fireEvent.click(screen.getByRole("link", { name: /Explorer les ventes sans compte/ }));
    expect(mocks.track.mock.calls).toEqual([
      ["home_cta_clicked", { target: "signup" }],
      ["home_cta_clicked", { target: "browse" }],
    ]);
  });

  it("mesure le lien du dernier écran, et rien pour un compte connecté", () => {
    render(<HomeBrowseWithoutAccount />);
    fireEvent.click(screen.getByRole("link", { name: /explorez les ventes sans compte/ }));
    expect(mocks.track).toHaveBeenCalledWith("home_cta_clicked", { target: "browse" });
    cleanup();
    mocks.track.mockClear();

    mocks.auth = { user: { id: "user-1" }, loading: false };
    render(<HomePrimaryAction browseLink />);
    fireEvent.click(screen.getByRole("link", { name: /Explorer les ventes/ }));
    expect(mocks.track).not.toHaveBeenCalled();
  });
});
