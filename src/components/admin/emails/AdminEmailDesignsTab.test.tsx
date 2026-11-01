// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailDesigns } from "@/lib/admin-emails/designs";

const mocks = vi.hoisted(() => ({ fetchDesigns: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/client-api/admin-emails", () => ({ fetchAdminEmailDesigns: mocks.fetchDesigns }));
vi.mock("@/lib/toast", () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  AdminSectionHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

import { AdminEmailDesignsTab } from "./AdminEmailDesignsTab";

const designs = (dark: boolean): EmailDesigns => ({
  dark,
  intro: "Aperçus rendus par les vrais gabarits.",
  templates: [
    {
      key: "alert",
      label: "Alerte de recherche",
      description: "Une alerte.",
      badges: [
        { text: "Catégorie : alert", tone: "neutral" },
        { text: "Expéditeur : Immojudis <alertes@immojudis.com>", tone: "neutral" },
      ],
      variants: [
        {
          key: "one",
          label: "Une vente",
          subject: "Objet de l’alerte",
          html: `<p>${dark ? "sombre" : "clair"}</p><script>alert(1)</script>`,
          text: "",
        },
      ],
    },
    {
      key: "auth_confirmation",
      label: "Authentification : confirmation",
      description: "Confirmer.",
      badges: [{ text: "Expéditeur : SMTP de Supabase", tone: "neutral" }],
      notice: "Copie de référence : appliquée par le workflow ou à coller dans Supabase.",
      variants: [
        {
          key: "token-hash",
          label: "Lien",
          subject: "Confirmez votre adresse",
          html: "<p>aperçu</p>",
          text: "",
          pasteHtml: "<p>{{ .Email }}</p>",
        },
      ],
    },
    {
      key: "contact_message",
      label: "Formulaire de contact",
      description: "Contact.",
      badges: [{ text: "Expéditeur : CONTACT_EMAIL_FROM non configuré", tone: "bad" }],
      variants: [
        { key: "c", label: "Contact", subject: "S", html: null, text: "Bonjour <b>texte</b>" },
      ],
    },
    {
      key: "commercial_confirmation",
      label: "Confirmation de commande",
      description: "Commande.",
      badges: [],
      variants: [],
      unavailable: "Aucun aperçu possible.",
    },
  ],
});

function renderTab() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminEmailDesignsTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.fetchDesigns.mockImplementation(async (dark: boolean) => designs(dark));
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("onglet Designs", () => {
  it("affiche chaque aperçu dans une iframe sandbox vide, sans aucun droit", async () => {
    renderTab();
    await screen.findByText("Alerte de recherche");

    const frames = document.querySelectorAll("iframe");
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.getAttribute("sandbox")).toBe("");
      expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(frame.hasAttribute("src")).toBe(false);
      expect(frame.getAttribute("sandbox") ?? "").not.toContain("allow-");
    }
    expect(frames[0].getAttribute("srcdoc")).toContain("clair");
  });

  it("montre l'objet, la catégorie et l'expéditeur effectif de chaque gabarit", async () => {
    renderTab();
    await screen.findByText("Alerte de recherche");

    expect(screen.getByText("Objet : Objet de l’alerte")).toBeTruthy();
    expect(screen.getByText("Catégorie : alert")).toBeTruthy();
    expect(screen.getByText("Expéditeur : Immojudis <alertes@immojudis.com>")).toBeTruthy();
    expect(screen.getByText("Expéditeur : CONTACT_EMAIL_FROM non configuré")).toBeTruthy();
    expect(screen.getByText("Expéditeur : SMTP de Supabase")).toBeTruthy();
  });

  it("recharge l'aperçu rendu par le serveur pour le mode sombre", async () => {
    renderTab();
    await screen.findByText("Alerte de recherche");
    expect(mocks.fetchDesigns).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Sombre" }));

    await waitFor(() => expect(mocks.fetchDesigns).toHaveBeenLastCalledWith(true));
    await waitFor(() =>
      expect(document.querySelector("iframe")?.getAttribute("srcdoc")).toContain("sombre"),
    );
  });

  it("change la largeur des aperçus entre 600 px et 375 px", async () => {
    renderTab();
    await screen.findByText("Alerte de recherche");
    const figure = () => document.querySelector("figure") as HTMLElement;
    expect(figure().style.width).toBe("600px");

    fireEvent.click(screen.getByRole("button", { name: "Mobile (375 px)" }));
    expect(figure().style.width).toBe("375px");
    expect(
      screen.getByRole("button", { name: "Mobile (375 px)" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("n'insère jamais un texte brut comme du HTML", async () => {
    renderTab();
    await screen.findByText("Formulaire de contact");
    const pre = document.querySelector("pre") as HTMLElement;
    expect(pre.textContent).toBe("Bonjour <b>texte</b>");
    expect(pre.querySelector("b")).toBeNull();
  });

  it("explique l'absence d'aperçu", async () => {
    renderTab();
    expect(await screen.findByText("Aucun aperçu possible.")).toBeTruthy();
  });

  it("propose de copier l'objet et le HTML des seuls emails Supabase", async () => {
    renderTab();
    await screen.findByText("Authentification : confirmation");
    expect(screen.getByText(/Copie de référence : appliquée par le workflow/)).toBeTruthy();
    expect(screen.getAllByText(/Copie de référence/)).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Copier le HTML" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Copier le HTML" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("<p>{{ .Email }}</p>"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copier l’objet" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("Confirmez votre adresse"),
    );
    expect(mocks.success).toHaveBeenCalledWith("HTML copié.");
  });

  it("annonce l'échec d'une copie", async () => {
    renderTab();
    await screen.findByText("Authentification : confirmation");
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("refus"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Copier le HTML" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("Copie impossible."));
  });

  it("propose de réessayer quand la galerie est indisponible", async () => {
    mocks.fetchDesigns.mockRejectedValue(new Error("Erreur HTTP 503"));
    renderTab();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
  });
});
