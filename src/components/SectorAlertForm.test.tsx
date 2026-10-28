// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  saving: false,
  analysis: false as boolean | undefined,
  returnTo: "",
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/hooks/use-has-analysis-access", () => ({
  useHasAnalysisAccess: () => state.analysis,
}));
vi.mock("@/hooks/use-create-alert", () => ({
  useCreateAlert: (options: { returnTo: string }) => {
    state.returnTo = options.returnTo;
    return { createAlertFromSearch: state.create, saving: state.saving };
  },
}));

import { SectorAlertForm } from "./SectorAlertForm";

beforeEach(() => {
  state.create.mockReset();
  state.create.mockResolvedValue({ status: "created", emailConsent: false });
  state.saving = false;
  state.analysis = false;
});
afterEach(cleanup);

describe("SectorAlertForm", () => {
  it("rappelle les critères, avec le nom du département", () => {
    render(<SectorAlertForm criteria={{ department: "33", maxPrice: 150000 }} />);
    const criteria = screen.getByRole("list", { name: "Critères de l'alerte" });
    expect(criteria.textContent).toContain("Lieu : Gironde (33)");
    expect(criteria.textContent).toContain("Mise à prix maximale");
    expect(state.returnTo).toBe("/alertes/creer?department=33&maxPrice=150000");
  });

  it("propose l'email récapitulatif en case décochée et crée l'alerte sans email par défaut", async () => {
    render(<SectorAlertForm criteria={{ department: "33" }} />);
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(
      screen.getByText(/Recevoir aussi un email récapitulatif \(un par semaine\)/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    const [search, options] = state.create.mock.calls[0];
    expect(search).toEqual({ department: "33" });
    expect(options).toEqual({ emailRecap: false, frequency: "weekly" });
    expect(await screen.findByText("Alerte créée.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Voir mes alertes" }).getAttribute("href")).toBe(
      "/alertes",
    );
  });

  it("transmet le consentement seulement quand la case est cochée", async () => {
    render(
      <SectorAlertForm
        criteria={{ department: "33" }}
        actionLabel="Recevoir les nouvelles ventes de ce secteur"
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(
      screen.getByRole("button", { name: "Recevoir les nouvelles ventes de ce secteur" }),
    );
    await waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(state.create.mock.calls[0][1]).toMatchObject({ emailRecap: true });
    expect((await screen.findByRole("status")).textContent).toContain("email récapitulatif");
  });

  it("nomme la section par son titre et déplace le focus sur « Alerte créée » à la création", async () => {
    render(<SectorAlertForm criteria={{ department: "33" }} />);
    const heading = screen.getByRole("heading", { level: 2 });
    expect(
      screen
        .getByRole("region", { name: heading.textContent ?? "" })
        .getAttribute("aria-labelledby"),
    ).toBe(heading.id);

    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    const created = await screen.findByRole("heading", { name: "Alerte créée." });
    expect(created.getAttribute("tabindex")).toBe("-1");
    await waitFor(() => expect(document.activeElement).toBe(created));
  });

  it("annonce un récapitulatif quotidien pour l'offre Analyse", async () => {
    state.analysis = true;
    render(<SectorAlertForm criteria={{ department: "33" }} />);
    expect(screen.getByText(/\(un par jour\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    await waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(state.create.mock.calls[0][1]).toMatchObject({ frequency: "daily" });
  });

  it("reste sur le formulaire quand la création échoue", async () => {
    state.create.mockResolvedValue({ status: "failed" });
    render(<SectorAlertForm criteria={{ department: "33" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    await waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(screen.queryByText("Alerte créée.")).toBeNull();
    expect(screen.getByRole("button", { name: "Créer l’alerte" })).toBeTruthy();
  });

  it("ne crée que les critères publics, même si l'adresse en contient d'autres", async () => {
    render(
      <SectorAlertForm criteria={{ department: "33", query: "texte libre", minYield: "9" }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    await waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(state.create.mock.calls[0][0]).toEqual({ department: "33" });
  });
});

describe("SectorAlertForm : « Pépites seulement »", () => {
  it("rappelle le critère et le transmet à la création", async () => {
    render(<SectorAlertForm criteria={{ department: "33", pepite: true }} />);
    expect(screen.getByRole("list", { name: "Critères de l'alerte" }).textContent).toContain(
      "Pépites seulement",
    );
    fireEvent.click(screen.getByRole("button", { name: "Créer l’alerte" }));
    await waitFor(() => expect(state.create).toHaveBeenCalled());
    expect(state.create.mock.calls[0][0]).toEqual({ department: "33", pepite: true });
  });

  it("n'affiche rien de plus sans le critère", () => {
    render(<SectorAlertForm criteria={{ department: "33" }} />);
    expect(document.body.textContent).not.toMatch(/pépite/i);
  });
});
