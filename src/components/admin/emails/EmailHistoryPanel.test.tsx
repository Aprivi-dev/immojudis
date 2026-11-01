// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ history: vi.fn(), message: vi.fn() }));
vi.mock("@/components/admin/AdminShell", () => ({
  AdminPanel: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("@/lib/client-api/admin-emails", () => ({
  fetchAdminEmailHistory: mocks.history,
  fetchAdminEmailMessage: mocks.message,
}));

import { EmailHistoryPanel } from "./EmailHistoryPanel";

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <EmailHistoryPanel />
    </QueryClientProvider>,
  );
}

const sentPage = (next: string | null, label = "premier") => ({
  rows: [
    {
      id: `log:${label}`,
      at: "01/11/2026 10:00",
      who: `${label}@example.test`,
      subject: `Objet ${label}`,
      tag: "Alerte de recherche",
      status: { text: "Remis", tone: "ok" },
    },
  ],
  next,
});

beforeEach(() => {
  mocks.history.mockResolvedValue(sentPage(null));
  mocks.message.mockResolvedValue({
    title: "Objet premier",
    lines: ["À : premier@example.test"],
    kind: "html",
    body: "<p>Bonjour</p>",
    attachments: [],
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("EmailHistoryPanel", () => {
  it("liste les envois avec leur statut et demande la première page", async () => {
    renderPanel();
    expect(await screen.findByText("Objet premier")).toBeTruthy();
    expect(screen.getByText("Remis")).toBeTruthy();
    const params = mocks.history.mock.calls[0][0] as URLSearchParams;
    expect(params.get("box")).toBe("sent");
    expect(params.get("refresh")).toBeNull();
  });

  it("charge la page suivante avec le curseur du serveur", async () => {
    mocks.history
      .mockResolvedValueOnce(sentPage("curseur-1"))
      .mockResolvedValueOnce(sentPage(null, "second"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Plus anciens" }));
    expect(await screen.findByText("Objet second")).toBeTruthy();
    expect((mocks.history.mock.calls[1][0] as URLSearchParams).get("cursor")).toBe("curseur-1");
  });

  it("cherche par adresse puis bascule sur les reçus", async () => {
    renderPanel();
    await screen.findByText("Objet premier");
    fireEvent.change(screen.getByLabelText("Rechercher une adresse"), {
      target: { value: "premier@" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rechercher" }));
    await waitFor(() =>
      expect(
        mocks.history.mock.calls.some(
          (call) => (call[0] as URLSearchParams).get("address") === "premier@",
        ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reçus" }));
    await waitFor(() =>
      expect(
        mocks.history.mock.calls.some(
          (call) => (call[0] as URLSearchParams).get("box") === "received",
        ),
      ).toBe(true),
    );
    expect(screen.queryByRole("button", { name: "Actualiser" })).toBeNull();
  });

  it("« Actualiser » demande l'état à Resend pour la première page seulement", async () => {
    renderPanel();
    await screen.findByText("Objet premier");
    fireEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));
    expect((mocks.history.mock.calls[1][0] as URLSearchParams).get("refresh")).toBe("1");
  });

  it("ouvre un message dans un cadre isolé : sandbox vide, sans référent, sans script", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("Objet premier"));
    const frame = (await screen.findByTitle("Contenu de l’email")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toBe("<p>Bonjour</p>");
    expect(mocks.message).toHaveBeenCalledWith("log:premier");
  });

  it("affiche un email reçu en texte, jamais en HTML, avec ses pièces jointes", async () => {
    mocks.message.mockResolvedValue({
      title: "Re: vente",
      lines: ["De : maitre@cabinet.example"],
      kind: "text",
      body: "<b>gras</b> [lien d’action masqué]",
      attachments: ["pv.pdf (20 Ko)"],
    });
    renderPanel();
    fireEvent.click(await screen.findByText("Objet premier"));
    expect(await screen.findByText("<b>gras</b> [lien d’action masqué]")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("pv.pdf (20 Ko)")).toBeTruthy();
  });

  it("annonce l'absence d'email et les erreurs", async () => {
    mocks.history.mockResolvedValue({ rows: [], next: null });
    renderPanel();
    expect(await screen.findByText("Aucun email.")).toBeTruthy();
    cleanup();
    mocks.history.mockRejectedValue(new Error("Erreur admin"));
    renderPanel();
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
