// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchProfile: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchInvestorProfile: mocks.fetchProfile,
  saveInvestorProfile: mocks.saveProfile,
  deleteInvestorProfile: mocks.deleteProfile,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { InvestorProfileForm } from "./InvestorProfileForm";

function renderForm() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <InvestorProfileForm userId="user-1" />
    </QueryClientProvider>,
  );
}

const saved = {
  downPaymentEur: 40_000,
  targetMarginPct: 12.5,
  worksPerM2Eur: 800,
  strategy: "revendre" as const,
};

beforeEach(() => {
  mocks.fetchProfile.mockResolvedValue({ profile: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("InvestorProfileForm", () => {
  it("propose un formulaire vide sans profil, sans bouton d'effacement", async () => {
    renderForm();
    expect(await screen.findByLabelText("Stratégie")).toBeTruthy();
    expect((screen.getByLabelText("Apport personnel") as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Effacer mon profil" })).toBeNull();
  });

  it("reprend les valeurs enregistrées", async () => {
    mocks.fetchProfile.mockResolvedValue({ profile: saved });
    renderForm();

    expect(((await screen.findByLabelText("Stratégie")) as HTMLSelectElement).value).toBe(
      "revendre",
    );
    expect((screen.getByLabelText("Apport personnel") as HTMLInputElement).value).toMatch(
      /^40\s000$/,
    );
    expect((screen.getByLabelText("Marge cible") as HTMLInputElement).value).toBe("12,5");
    expect((screen.getByLabelText("Travaux au m²") as HTMLInputElement).value).toBe("800");
    expect(screen.getByRole("button", { name: "Effacer mon profil" })).toBeTruthy();
  });

  it("enregistre les hypothèses saisies, chacune facultative", async () => {
    mocks.saveProfile.mockResolvedValue({ profile: saved });
    renderForm();

    fireEvent.change(await screen.findByLabelText("Stratégie"), { target: { value: "louer" } });
    fireEvent.change(screen.getByLabelText("Apport personnel"), { target: { value: "40 000" } });
    fireEvent.change(screen.getByLabelText("Marge cible"), { target: { value: "12,5" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer mon profil" }));

    await waitFor(() =>
      expect(mocks.saveProfile).toHaveBeenCalledWith({
        data: {
          downPaymentEur: 40_000,
          targetMarginPct: 12.5,
          worksPerM2Eur: null,
          strategy: "louer",
        },
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("refuse une valeur illisible ou hors borne sans rien envoyer", async () => {
    renderForm();

    fireEvent.change(await screen.findByLabelText("Marge cible"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer mon profil" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Marge cible");

    fireEvent.change(screen.getByLabelText("Marge cible"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer mon profil" }));
    expect((await screen.findByRole("alert")).textContent).toContain("au moins une hypothèse");
    expect(mocks.saveProfile).not.toHaveBeenCalled();
  });

  it("efface le profil après confirmation, et pas sans elle", async () => {
    mocks.fetchProfile.mockResolvedValue({ profile: saved });
    mocks.deleteProfile.mockResolvedValue({ ok: true, removed: true });
    const confirm = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderForm();

    const button = await screen.findByRole("button", { name: "Effacer mon profil" });
    fireEvent.click(button);
    expect(mocks.deleteProfile).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(mocks.deleteProfile).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledTimes(2);
    // Le formulaire repart à vide une fois le profil effacé.
    await waitFor(() =>
      expect((screen.getByLabelText("Apport personnel") as HTMLInputElement).value).toBe(""),
    );
  });

  it("laisse le formulaire utilisable quand la lecture du profil échoue", async () => {
    mocks.fetchProfile.mockRejectedValue(new Error("indisponible"));
    renderForm();
    expect(await screen.findByLabelText("Stratégie")).toBeTruthy();
  });
});
