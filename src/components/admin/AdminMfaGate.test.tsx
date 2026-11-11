// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assurance: vi.fn(),
  listFactors: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: mocks.assurance,
        listFactors: mocks.listFactors,
        challenge: mocks.challenge,
        verify: mocks.verify,
      },
    },
  },
}));

import { AdminMfaGate } from "./AdminMfaGate";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminMfaGate", () => {
  it("shows the verification screen before any admin page when the session is aal1", async () => {
    mocks.assurance.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    mocks.listFactors.mockResolvedValue({
      data: { all: [{ id: "factor-1", factor_type: "totp", status: "verified" }] },
    });

    render(
      <AdminMfaGate>
        <p>Tableau de bord</p>
      </AdminMfaGate>,
    );

    expect(await screen.findByRole("heading", { name: "Code de vérification" })).toBeTruthy();
    expect(screen.queryByText("Tableau de bord")).toBeNull();
  });

  it("opens the admin page once the code is verified", async () => {
    mocks.assurance.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    mocks.listFactors.mockResolvedValue({
      data: { all: [{ id: "factor-1", factor_type: "totp", status: "verified" }] },
    });
    mocks.challenge.mockResolvedValue({ data: { id: "challenge-1" }, error: null });
    mocks.verify.mockResolvedValue({ data: {}, error: null });

    render(
      <AdminMfaGate>
        <p>Tableau de bord</p>
      </AdminMfaGate>,
    );
    fireEvent.change(await screen.findByLabelText("Code à 6 chiffres"), {
      target: { value: "123 456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Vérifier" }));

    await waitFor(() => expect(screen.getByText("Tableau de bord")).toBeTruthy());
    expect(mocks.verify).toHaveBeenCalledWith({
      factorId: "factor-1",
      challengeId: "challenge-1",
      code: "123456",
    });
  });

  it("rejects a malformed code without calling the auth service", async () => {
    mocks.assurance.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    mocks.listFactors.mockResolvedValue({
      data: { all: [{ id: "factor-1", factor_type: "totp", status: "verified" }] },
    });

    render(
      <AdminMfaGate>
        <p>Tableau de bord</p>
      </AdminMfaGate>,
    );
    fireEvent.change(await screen.findByLabelText("Code à 6 chiffres"), {
      target: { value: "12" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Vérifier" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.challenge).not.toHaveBeenCalled();
  });

  it("gives the button back when the auth service throws instead of answering", async () => {
    mocks.assurance.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal2" },
      error: null,
    });
    mocks.listFactors.mockResolvedValue({
      data: { all: [{ id: "factor-1", factor_type: "totp", status: "verified" }] },
    });
    // Réseau coupé : l'appel lève au lieu de rendre `{ error }`.
    mocks.challenge.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mocks.challenge.mockResolvedValue({ data: { id: "challenge-1" }, error: null });
    mocks.verify.mockResolvedValue({ data: {}, error: null });

    render(
      <AdminMfaGate>
        <p>Tableau de bord</p>
      </AdminMfaGate>,
    );
    fireEvent.change(await screen.findByLabelText("Code à 6 chiffres"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Vérifier" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    // Le bouton n'est pas resté sur « Vérification… » : une seconde tentative aboutit.
    const retry = screen.getByRole("button", { name: "Vérifier" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("Tableau de bord")).toBeTruthy());
  });

  it("lets an administrator without a factor through so they can enrol", async () => {
    mocks.assurance.mockResolvedValue({
      data: { currentLevel: "aal1", nextLevel: "aal1" },
      error: null,
    });

    render(
      <AdminMfaGate>
        <p>Tableau de bord</p>
      </AdminMfaGate>,
    );

    expect(await screen.findByText("Tableau de bord")).toBeTruthy();
  });
});
