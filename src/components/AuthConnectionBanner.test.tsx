// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  retry: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => mocks.auth }));

import { AuthConnectionBanner } from "./AuthConnectionBanner";

beforeEach(() => {
  mocks.retry.mockReset();
  mocks.auth = {
    loading: false,
    authError: "Votre session n’a pas pu être vérifiée.",
    authErrorKind: "unavailable",
    retry: mocks.retry,
  };
  window.history.replaceState(null, "", "/sales?city=Lyon");
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("AuthConnectionBanner", () => {
  it("dit que la connexion n'a pas pu être vérifiée et propose de réessayer ou de se reconnecter", () => {
    render(<AuthConnectionBanner />);
    expect(screen.getByRole("alert").textContent).toContain(
      "Nous n’avons pas pu vérifier votre connexion.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(mocks.retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Se reconnecter" }).getAttribute("href")).toBe(
      "/login?redirect=%2Fsales%3Fcity%3DLyon",
    );
  });

  it("garde l'adresse de connexion qu'on lui donne", () => {
    render(<AuthConnectionBanner loginHref="/login?redirect=%2Fsales%2Fx&reason=fiche" />);
    expect(screen.getByRole("link", { name: "Se reconnecter" }).getAttribute("href")).toBe(
      "/login?redirect=%2Fsales%2Fx&reason=fiche",
    );
  });

  it("distingue la session expirée : seule la reconnexion est proposée", () => {
    mocks.auth = { ...mocks.auth, authErrorKind: "expired" };
    render(<AuthConnectionBanner />);
    expect(screen.getByRole("alert").textContent).toContain("Votre session a expiré.");
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
    expect(screen.getByRole("link", { name: "Se reconnecter" })).toBeTruthy();
  });

  it("n'apparaît ni sans erreur ni pendant la vérification", () => {
    mocks.auth = { ...mocks.auth, authError: null, authErrorKind: null };
    const { container, rerender } = render(<AuthConnectionBanner />);
    expect(container.textContent).toBe("");
    mocks.auth = { ...mocks.auth, authError: "x", loading: true };
    rerender(<AuthConnectionBanner />);
    expect(container.textContent).toBe("");
  });
});
