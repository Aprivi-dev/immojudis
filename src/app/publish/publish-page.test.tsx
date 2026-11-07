// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "pro-1", email: "pro@example.test" },
    profile: null,
    loading: false,
  }),
}));
vi.mock("@/lib/account", () => ({
  isProfessionalAccount: () => true,
  getProfessionalStatus: () => "approved",
}));
vi.mock("@/lib/publication-requests-client", () => ({
  fetchPublicationRequestsClient: vi.fn().mockResolvedValue({ requests: [] }),
  submitPublicationRequestClient: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { PublishPage } from "./publish-page";

afterEach(cleanup);

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PublishPage />
    </QueryClientProvider>,
  );
}

describe("page de publication professionnelle", () => {
  it("décrit exactement la mise en avant éditoriale: aucun effet sur l'ordre des résultats", () => {
    renderPage();
    const checkbox = screen.getByRole("checkbox", {
      name: /mise en avant éditoriale \(sélections et contenus Immojudis\)/i,
    });
    const text = checkbox.closest("label")?.textContent ?? "";
    expect(text).toContain("sélections et contenus éditoriaux d'Immojudis");
    expect(text).toContain("aucun effet sur l'ordre des résultats de recherche");
    expect(text).not.toMatch(/pages de recherche/);
    expect(text).toContain(
      "Si une contrepartie est convenue, le contenu concerné est signalé comme publicité.",
    );
  });

  it("ne coche aucune option de promotion d'office", () => {
    renderPage();
    const promotions = screen
      .getAllByRole("checkbox")
      .filter((box) =>
        /^Demander (une mise en avant|une préparation SEO|un relais)/.test(
          box.closest("label")?.textContent ?? "",
        ),
      );
    expect(promotions).toHaveLength(3);
    for (const box of promotions) expect((box as HTMLInputElement).checked).toBe(false);
  });

  it("présente la validation sans vocabulaire interne (repasse n° 36)", () => {
    renderPage();
    const text = document.body.textContent ?? "";
    expect(text).toContain(
      "Votre demande et ses pièces sont enregistrées en attente de validation. L'équipe Immojudis les vérifie, peut les compléter, puis valide la mise en ligne.",
    );
    expect(text).not.toMatch(/panel admin|côté admin|file de validation admin/i);
  });

  it("garde des textes, champs et cases lisibles sur fond clair (repasse n° 6 et 14)", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1 }).className).toContain("sm:text-[2.5rem]");
    expect(screen.getByRole("progressbar", { name: "Préparation de la demande" })).toBeTruthy();
    // Les cases des documents sont visibles : leur état ne repose plus sur une teinte.
    const document = screen.getByRole("checkbox", { name: "Cahier des conditions de vente" });
    expect(document.className).not.toContain("sr-only");
    expect(screen.getByRole("button", { name: "Envoyer pour validation" }).className).toContain(
      "bg-brand-navy",
    );
    expect(window.document.body.innerHTML).not.toMatch(
      /text-(?:amber|red|emerald)-(?:50|100)\b|text-\[1[01]px\]|liquid-|glass-shell|bg-white\/10/,
    );
  });
});
