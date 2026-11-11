// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assurance: vi.fn(),
  listFactors: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  challenge: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: mocks.assurance,
        listFactors: mocks.listFactors,
        enroll: mocks.enroll,
        unenroll: mocks.unenroll,
        challenge: mocks.challenge,
        verify: mocks.verify,
      },
    },
  },
}));

import { AdminSecurityPage } from "./AdminSecurityPage";

const ENROL = "Configurer l'application d'authentification";

function noFactor() {
  mocks.listFactors.mockResolvedValue({ data: { all: [] } });
  mocks.assurance.mockResolvedValue({ data: { currentLevel: "aal1" } });
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AdminSecurityPage", () => {
  it("offers enrolment to an administrator without a factor", async () => {
    noFactor();
    render(<AdminSecurityPage />);
    expect(await screen.findByRole("button", { name: ENROL })).toBeTruthy();
  });

  it("says the factor is active when one is verified", async () => {
    mocks.listFactors.mockResolvedValue({
      data: { all: [{ id: "factor-1", factor_type: "totp", status: "verified" }] },
    });
    mocks.assurance.mockResolvedValue({ data: { currentLevel: "aal2" } });
    render(<AdminSecurityPage />);
    expect(await screen.findByText(/Application d'authentification active/)).toBeTruthy();
  });

  it("leaves « Chargement… » and offers a retry when the factors cannot be read", async () => {
    mocks.listFactors.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mocks.assurance.mockResolvedValue({ data: { currentLevel: "aal1" } });
    render(<AdminSecurityPage />);

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Chargement…")).toBeNull();
    // Sans savoir si un facteur existe, l'enrôlement n'est pas proposé.
    expect(screen.queryByRole("button", { name: ENROL })).toBeNull();

    mocks.listFactors.mockResolvedValue({ data: { all: [] } });
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByRole("button", { name: ENROL })).toBeTruthy();
  });

  it("gives the button back when starting the enrolment throws", async () => {
    noFactor();
    mocks.enroll.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<AdminSecurityPage />);

    fireEvent.click(await screen.findByRole("button", { name: ENROL }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: ENROL }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it("gives the button back when the verification throws, then activates on a second try", async () => {
    noFactor();
    mocks.enroll.mockResolvedValue({
      data: { id: "factor-1", totp: { qr_code: "data:image/svg+xml;utf8,qr", secret: "SECRET" } },
      error: null,
    });
    mocks.challenge.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    mocks.challenge.mockResolvedValue({ data: { id: "challenge-1" }, error: null });
    mocks.verify.mockResolvedValue({ data: {}, error: null });
    render(<AdminSecurityPage />);

    fireEvent.click(await screen.findByRole("button", { name: ENROL }));
    fireEvent.change(await screen.findByLabelText("Code à 6 chiffres"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Activer" }));
    expect(await screen.findByRole("alert")).toBeTruthy();

    const retry = screen.getByRole("button", { name: "Activer" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mocks.verify).toHaveBeenCalledWith({
      factorId: "factor-1",
      challengeId: "challenge-1",
      code: "123456",
    });
  });
});
