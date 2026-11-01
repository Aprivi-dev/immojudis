// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailListView } from "@/lib/admin-emails/views";

vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  AdminSectionHeading: ({ title }: { title: string }) => <h2>{title}</h2>,
}));

import { AdminEmailListTab } from "./AdminEmailListTab";

const view = (overrides: Partial<EmailListView> = {}): EmailListView => ({
  footnote: "Vérifié le 2 novembre 2026 à 11:00.",
  alerts: ["Aucun DMARC publié pour immojudis.com."],
  sections: [
    {
      title: "Secrets",
      description: "Seul l’état est affiché.",
      notice: { text: "Resend limite le débit.", tone: "bad" },
      items: [
        {
          title: "Envoi",
          code: "RESEND_API_KEY",
          badges: [{ text: "Renseigné", tone: "ok" }],
          lines: [
            { text: "v=DMARC1; p=none", mono: true },
            { text: "Manquant", bad: true },
          ],
        },
      ],
    },
  ],
  ...overrides,
});

function renderTab(fetchView: (refresh?: boolean) => Promise<EmailListView>) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminEmailListTab
        queryKey="test-view"
        loading="Chargement des adresses…"
        fetchView={fetchView}
      />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("AdminEmailListTab", () => {
  it("affiche les sections, badges, valeurs et alertes composés par le serveur", async () => {
    renderTab(vi.fn().mockResolvedValue(view()));

    expect(await screen.findByText("Secrets")).toBeTruthy();
    expect(screen.getByText("RESEND_API_KEY")).toBeTruthy();
    expect(screen.getByText("Renseigné")).toBeTruthy();
    expect(screen.getByText("Resend limite le débit.")).toBeTruthy();
    expect(screen.getByText("v=DMARC1; p=none").className).toContain("font-mono");
    expect(screen.getByText("Manquant").className).toContain("text-danger");
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Aucun DMARC publié pour immojudis.com.")).toBeTruthy();
  });

  it("n'insère jamais un texte du serveur comme du HTML", async () => {
    renderTab(
      vi
        .fn()
        .mockResolvedValue(
          view({ alerts: ["<img src=x onerror=alert(1)>"], footnote: "<b>gras</b>" }),
        ),
    );
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it("n'offre « Revérifier » qu'avec une note de vérification, et la relance sans cache", async () => {
    const fetchView = vi.fn().mockResolvedValue(view());
    renderTab(fetchView);
    await screen.findByText("Secrets");

    fetchView.mockResolvedValue(view({ alerts: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Revérifier" }));

    await waitFor(() => expect(fetchView).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("n'affiche ni note ni bouton pour une vue statique", async () => {
    renderTab(vi.fn().mockResolvedValue(view({ footnote: undefined, alerts: [] })));
    await screen.findByText("Secrets");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("annonce le chargement puis propose de réessayer en cas d'échec", async () => {
    const fetchView = vi.fn().mockRejectedValue(new Error("Erreur HTTP 503"));
    renderTab(fetchView);
    expect(screen.getByRole("status").textContent).toBe("Chargement des adresses…");

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Erreur HTTP 503")).toBeTruthy();
    fetchView.mockResolvedValue(view());
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText("Secrets")).toBeTruthy();
  });
});
