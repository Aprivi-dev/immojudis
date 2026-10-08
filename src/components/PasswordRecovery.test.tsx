// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordRecovery } from "./PasswordRecovery";

const auth = vi.hoisted(() => ({
  getSession: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));
vi.mock("@/integrations/supabase/client", () => ({
  isSupabaseConfigured: true,
  supabase: { auth },
}));
vi.mock("next/link", () => ({ default: "a" }));

beforeEach(() => {
  vi.clearAllMocks();
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  auth.resetPasswordForEmail.mockResolvedValue({ error: null });
  auth.updateUser.mockResolvedValue({ error: null });
  auth.signOut.mockResolvedValue({ error: null });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("password recovery", () => {
  it.each([
    "reauthentication_needed",
    "reauthentication_not_valid",
    "current_password_required",
    "current_password_invalid",
    "current_password_mismatch",
  ])("requires a fresh recovery link when the existing session returns %s", async (code) => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: "existing" } } } });
    auth.updateUser.mockResolvedValue({ error: { code } });
    render(<PasswordRecovery reset />);
    fireEvent.change(await screen.findByLabelText("Nouveau mot de passe"), {
      target: { value: "new-password" },
    });
    fireEvent.change(screen.getByLabelText("Confirmer le mot de passe"), {
      target: { value: "new-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer le mot de passe" }));
    const link = await screen.findByRole("link", { name: "Demander un nouveau lien" });
    expect(link.getAttribute("href")).toBe("/mot-de-passe-oublie");
    expect(screen.queryByRole("button", { name: "Enregistrer le mot de passe" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("uses the recovery destination and does not disclose whether the email exists", async () => {
    render(<PasswordRecovery />);
    fireEvent.change(screen.getByLabelText("Adresse email du compte"), {
      target: { value: "test@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Recevoir le lien de réinitialisation" }));
    await waitFor(() =>
      expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("test@example.test", {
        redirectTo: `${window.location.origin}/reinitialiser-mot-de-passe`,
      }),
    );
    expect((await screen.findByRole("status")).textContent).toContain("Si un compte correspond");
  });

  it("does not accept an expired link even if another session is present", async () => {
    window.history.replaceState(null, "", "/reinitialiser-mot-de-passe#error=access_denied");
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: "existing" } } } });
    render(<PasswordRecovery reset />);
    expect(await screen.findByRole("link", { name: "Demander un nouveau lien" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Enregistrer le mot de passe" })).toBeNull();
    expect(auth.updateUser).not.toHaveBeenCalled();
  });

  it("validates confirmation and preserves success if sign-out fails after the update", async () => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: "recovery" } } } });
    auth.signOut.mockRejectedValue(new Error("network unavailable"));
    render(<PasswordRecovery reset />);
    const password = await screen.findByLabelText("Nouveau mot de passe");
    fireEvent.change(password, { target: { value: "test-password" } });
    fireEvent.change(screen.getByLabelText("Confirmer le mot de passe"), {
      target: { value: "different-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer le mot de passe" }));
    expect(screen.getByRole("alert").textContent).toContain("identiques");
    expect(auth.updateUser).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Confirmer le mot de passe"), {
      target: { value: "test-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer le mot de passe" }));
    expect((await screen.findByRole("status")).textContent).toContain("a été modifié");
    expect(auth.updateUser).toHaveBeenCalledWith({ password: "test-password" });
  });
});
