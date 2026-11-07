// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPrivacyRequests: vi.fn(),
  createPrivacyRequestClient: vi.fn(),
}));

vi.mock("@/lib/client-api", () => ({
  fetchPrivacyRequests: mocks.fetchPrivacyRequests,
  createPrivacyRequestClient: mocks.createPrivacyRequestClient,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { RightsPage } from "./rights-page";

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RightsPage />
    </QueryClientProvider>,
  );
}

function request(overrides: Record<string, unknown>) {
  return {
    id: "r1",
    requestType: "access",
    status: "received",
    message: null,
    resolutionCode: null,
    submittedAt: "2026-11-01T10:00:00.000Z",
    dueAt: "2026-12-01T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  mocks.fetchPrivacyRequests.mockResolvedValue({ requests: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("/mes-droits (repasse n° 6 et 14)", () => {
  it("garde le texte des droits et un seul titre de page", () => {
    renderPage();
    const title = screen.getByRole("heading", { level: 1, name: "Mes droits" });
    expect(title.className).toContain("sm:text-[2.5rem]");
    expect(document.body.textContent).toContain(
      "aucune pièce d’identité n’est demandée sauf doute raisonnable",
    );
    expect(document.body.textContent).toContain("dans un délai maximal d’un mois");
  });

  it("présente des champs lisibles, décrits, et un bouton principal", () => {
    renderPage();
    const select = screen.getByRole("combobox", { name: "Nature de la demande" });
    expect(select.className).toContain("form-input");
    expect(select.getAttribute("aria-describedby")).toBe("rights-request-detail");
    expect(screen.getByRole("textbox", { name: "Précisions utiles" }).className).toContain(
      "form-textarea",
    );
    expect(screen.getByRole("button", { name: "Envoyer la demande" }).className).toContain(
      "bg-brand-navy",
    );
  });

  it("affiche les statuts en pastilles de la charte, sans couleurs d'un thème sombre", async () => {
    mocks.fetchPrivacyRequests.mockResolvedValue({
      requests: [request({ id: "a" }), request({ id: "b", status: "completed" })],
    });
    renderPage();

    expect((await screen.findByText("Traitée")).className).toContain("text-success");
    expect(screen.getByText("Reçue").className).toContain("text-gold-text");
    expect(document.body.innerHTML).not.toMatch(
      /text-(?:emerald|red)-(?:100|200)\b|text-\[1[01]px\]|text-\[10px\]|liquid-|glass-shell|border-white\/10/,
    );
  });

  it("annonce une erreur de suivi en bandeau d'alerte", async () => {
    mocks.fetchPrivacyRequests.mockRejectedValue(new Error("Suivi indisponible"));
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.className).toContain("text-danger");
  });
});
