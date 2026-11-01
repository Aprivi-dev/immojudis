// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  AdminShell: ({ children, activeSection }: { children: ReactNode; activeSection: string }) => (
    <main data-section={activeSection}>{children}</main>
  ),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/components/admin/emails/AdminEmailDesignsTab", () => ({
  AdminEmailDesignsTab: () => <div>onglet des designs</div>,
}));
vi.mock("@/components/admin/emails/AdminEmailListTab", () => ({
  AdminEmailListTab: ({ queryKey }: { queryKey: string }) => <div>liste : {queryKey}</div>,
}));
vi.mock("@/lib/client-api/admin-emails", () => ({
  fetchAdminEmailAddresses: vi.fn(),
  fetchAdminEmailTemplates: vi.fn(),
}));

import { AdminEmailsPage } from "./admin-emails-page";

beforeEach(() => window.history.replaceState(null, "", "/admin/emails"));
afterEach(cleanup);

describe("AdminEmailsPage", () => {
  it("s'ouvre sur Designs et active la rubrique Emails de la navigation", () => {
    render(<AdminEmailsPage />);
    expect(document.querySelector("main")?.getAttribute("data-section")).toBe("emails");
    expect(screen.getByRole("tab", { name: "Designs" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Designs",
      "Adresses",
      "Modèles",
      "Historique",
    ]);
  });

  it("ouvre l'onglet demandé par l'adresse", () => {
    window.history.replaceState(null, "", "/admin/emails?onglet=adresses");
    render(<AdminEmailsPage />);
    expect(screen.getByRole("tab", { name: "Adresses" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("liste : admin-emails-addresses")).toBeTruthy();
    expect(screen.queryByText("onglet des designs")).toBeNull();
  });

  it("ignore un onglet inconnu", () => {
    window.history.replaceState(null, "", "/admin/emails?onglet=inconnu");
    render(<AdminEmailsPage />);
    expect(screen.getByRole("tab", { name: "Designs" }).getAttribute("aria-selected")).toBe("true");
  });

  it("écrit l'onglet choisi dans l'adresse, sans navigation", () => {
    render(<AdminEmailsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Modèles" }));
    expect(window.location.search).toBe("?onglet=templates");
    expect(screen.getByRole("tab", { name: "Modèles" }).getAttribute("aria-selected")).toBe("true");
  });

  it("change d'onglet aux flèches du clavier", () => {
    render(<AdminEmailsPage />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Designs" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Adresses" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Adresses" }), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Designs" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Historique" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("annonce l'historique comme bientôt disponible", () => {
    window.history.replaceState(null, "", "/admin/emails?onglet=historique");
    render(<AdminEmailsPage />);
    expect(screen.getByText(/bientôt disponible/)).toBeTruthy();
  });
});
