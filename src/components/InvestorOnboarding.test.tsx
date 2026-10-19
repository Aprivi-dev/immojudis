// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvestorOnboarding } from "./InvestorOnboarding";

const navigate = vi.hoisted(() => vi.fn());
const alerts = vi.hoisted(() => ({
  create: vi.fn(),
  saving: false,
  analysis: false as boolean | undefined,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigate, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "user-1" } }) }));
vi.mock("@/hooks/use-has-analysis-access", () => ({
  useHasAnalysisAccess: () => alerts.analysis,
}));
vi.mock("@/hooks/use-create-alert", () => ({
  useCreateAlert: () => ({ createAlertFromSearch: alerts.create, saving: alerts.saving }),
}));
beforeEach(() => {
  alerts.analysis = false;
  alerts.saving = false;
  alerts.create.mockResolvedValue({ status: "created", emailConsent: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function goToLastStep(area: string, extra: { homeType?: string; maxPrice?: string } = {}) {
  fireEvent.change(screen.getByLabelText("Ville, département ou région"), {
    target: { value: area },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
  if (extra.homeType) {
    fireEvent.change(screen.getByLabelText("Type de bien"), { target: { value: extra.homeType } });
  }
  if (extra.maxPrice) {
    fireEvent.change(screen.getByLabelText("Mise à prix maximale (€)"), {
      target: { value: extra.maxPrice },
    });
  }
  fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
}

const ALERT_LABEL =
  "Créer ma première alerte avec ces critères (un email récapitulatif par semaine)";

describe("investor welcome flow", () => {
  it("keeps criteria when going back, then opens the filtered catalogue", () => {
    render(<InvestorOnboarding />);
    fireEvent.change(screen.getByLabelText("Ville, département ou région"), {
      target: { value: "Bordeaux" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    fireEvent.change(screen.getByLabelText("Type de bien"), { target: { value: "apartment" } });
    fireEvent.change(screen.getByLabelText("Mise à prix maximale (€)"), {
      target: { value: "150000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Retour" }));
    expect((screen.getByLabelText("Ville, département ou région") as HTMLInputElement).value).toBe(
      "Bordeaux",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    expect((screen.getByLabelText("Mise à prix maximale (€)") as HTMLInputElement).value).toBe(
      "150000",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    expect(screen.getByRole("heading", { name: "Votre première recherche" })).toBe(
      document.activeElement,
    );
    expect(screen.getByText("Bordeaux")).toBeTruthy();
    expect(screen.getByRole("link", { name: /annonce exemple/ }).getAttribute("href")).toBe(
      "/annonce-exemple",
    );
    fireEvent.click(screen.getByRole("button", { name: "Voir les biens" }));
    expect(navigate).toHaveBeenCalledWith(
      "/sales?query=Bordeaux&maxPrice=150000&homeTypes=apartment",
    );
  });
  it("announces the monthly unlocks of the free account instead of a flat « Analyse only »", () => {
    render(<InvestorOnboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Chaque mois, vous pouvez débloquer 3 ventes en détail (enchère plafond, lecture des pièces, historique, selon la vente). L’offre Analyse les ouvre toutes.",
    );
    expect(text).not.toContain("nécessitent un accès Analyse");
  });

  it.each([
    ["33", "Département 33"],
    ["33000", "Département 33"],
    ["Bordeaux", "Bordeaux"],
    ["", "Tous les secteurs couverts"],
  ])("shows what was typed as the sector of the recap (%s)", (area, shown) => {
    render(<InvestorOnboarding />);
    fireEvent.change(screen.getByLabelText("Ville, département ou région"), {
      target: { value: area },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    const sector = screen.getByText("Secteur").nextElementSibling;
    expect(sector?.textContent).toBe(shown);
    // A département typed as a number is never reported as « all sectors ».
    if (area) expect(document.body.textContent).not.toContain("Tous les secteurs couverts");
  });

  it("allows all fields to be skipped without payment or a write request", () => {
    render(<InvestorOnboarding />);
    expect(
      screen.getByRole("link", { name: "Passer et explorer le catalogue" }).getAttribute("href"),
    ).toBe("/sales");
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuer" }));
    fireEvent.click(screen.getByRole("button", { name: "Voir les biens" }));
    expect(navigate).toHaveBeenCalledWith("/sales");
  });

  describe("première alerte à la dernière étape", () => {
    it("propose la case, jamais pré-cochée, avec la mention de l'email hebdomadaire", () => {
      render(<InvestorOnboarding />);
      goToLastStep("33", { maxPrice: "150000" });
      const checkbox = screen.getByRole("checkbox", { name: ALERT_LABEL }) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      expect(checkbox.disabled).toBe(false);
      const help = document.getElementById(checkbox.getAttribute("aria-describedby")!);
      expect(help?.textContent).toContain("récapitulatif hebdomadaire");
      expect(help?.textContent).toContain("à tout moment");
    });

    it("n'écrit rien tant que la case reste décochée", () => {
      render(<InvestorOnboarding />);
      goToLastStep("33");
      fireEvent.click(screen.getByRole("button", { name: "Voir les biens" }));
      expect(alerts.create).not.toHaveBeenCalled();
      expect(navigate).toHaveBeenCalledWith("/sales?department=33");
    });

    it("crée l'alerte hebdomadaire avec le consentement, puis ouvre le catalogue filtré", async () => {
      render(<InvestorOnboarding />);
      goToLastStep("33", { homeType: "apartment", maxPrice: "150000" });
      fireEvent.click(screen.getByRole("checkbox", { name: ALERT_LABEL }));
      fireEvent.click(screen.getByRole("button", { name: "Voir les biens" }));
      await waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(alerts.create).toHaveBeenCalledTimes(1);
      const [search, options] = alerts.create.mock.calls[0];
      expect(search).toMatchObject({
        department: "33",
        maxPrice: 150000,
        homeTypes: ["apartment"],
      });
      expect(options).toMatchObject({ frequency: "weekly", emailRecap: true });
      expect(navigate).toHaveBeenCalledWith(
        "/sales?department=33&maxPrice=150000&homeTypes=apartment",
      );
    });

    it("reste sur l'étape quand l'alerte n'a pas pu être créée", async () => {
      alerts.create.mockResolvedValue({ status: "failed" });
      render(<InvestorOnboarding />);
      goToLastStep("33");
      fireEvent.click(screen.getByRole("checkbox", { name: ALERT_LABEL }));
      fireEvent.click(screen.getByRole("button", { name: "Voir les biens" }));
      await waitFor(() => expect(alerts.create).toHaveBeenCalled());
      expect(navigate).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Voir les biens" })).toBeTruthy();
    });

    it("grise la case sans aucun critère et dit pourquoi", () => {
      render(<InvestorOnboarding />);
      goToLastStep("");
      const checkbox = screen.getByRole("checkbox", { name: ALERT_LABEL }) as HTMLInputElement;
      expect(checkbox.disabled).toBe(true);
      expect(document.body.textContent).toContain("Indiquez un secteur, un type de bien");
    });

    it("grise la case pour un secteur en texte libre avec l'offre gratuite, pas avec Analyse", () => {
      const { unmount } = render(<InvestorOnboarding />);
      goToLastStep("Bordeaux");
      expect(
        (screen.getByRole("checkbox", { name: ALERT_LABEL }) as HTMLInputElement).disabled,
      ).toBe(true);
      expect(document.body.textContent).toContain("indiquez son numéro (ex. 33)");
      unmount();

      alerts.analysis = true;
      render(<InvestorOnboarding />);
      goToLastStep("Bordeaux");
      expect(
        (screen.getByRole("checkbox", { name: ALERT_LABEL }) as HTMLInputElement).disabled,
      ).toBe(false);
    });
  });
});
