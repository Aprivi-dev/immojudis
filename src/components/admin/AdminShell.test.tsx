// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AdminShell, type AdminSection } from "./AdminShell";

afterEach(cleanup);

function renderShell(activeSection: AdminSection) {
  render(
    <AdminShell
      activeSection={activeSection}
      title="Vue"
      description="Description"
      adminEmail="admin@example.test"
    >
      <p>Contenu</p>
    </AdminShell>,
  );
  // Le menu est rendu deux fois (barre latérale et tiroir mobile) : la barre latérale suffit.
  return screen.getAllByRole("navigation", { name: "Navigation administrateur" })[0];
}

describe("AdminShell", () => {
  it("propose dix entrées : Comptes regroupe inscriptions et clients, Pépites est dans Qualité", () => {
    const menu = renderShell("overview");
    const links = within(menu).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Vue d’ensemble", "/admin"],
      ["Opérations", "/admin/operations"],
      ["Agent IA", "/admin/agent-ia"],
      ["Emails", "/admin/emails"],
      ["Qualité des données", "/admin/quality"],
      ["Comptes", "/admin/comptes"],
      ["Pilotage", "/admin/pilotage"],
      ["Avocats", "/admin/lawyers"],
      ["Conformité", "/admin/compliance"],
      ["Configuration", "/admin/settings"],
    ]);
  });

  it("met « Sécurité du compte » sous l'adresse de l'administrateur, hors du menu", () => {
    const menu = renderShell("security");
    const [security] = screen.getAllByRole("link", { name: "Sécurité du compte" });
    expect(security.getAttribute("href")).toBe("/admin/securite");
    expect(security.getAttribute("aria-current")).toBe("page");
    expect(menu.contains(security)).toBe(false);
    expect(within(menu).queryByRole("link", { current: "page" })).toBeNull();
  });

  it("garde Publications joignable par son adresse sans entrée de menu active", () => {
    const menu = renderShell("publications");
    expect(within(menu).queryByRole("link", { name: "Publications" })).toBeNull();
    expect(within(menu).queryByRole("link", { current: "page" })).toBeNull();
  });
});
