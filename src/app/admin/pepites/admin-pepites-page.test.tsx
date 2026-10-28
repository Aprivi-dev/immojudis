// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminPepitesView } from "@/lib/admin-pepites-view";
import { AdminPepitesPage } from "./admin-pepites-page";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { email: "admin@example.test" } }) }));
vi.mock("@/lib/client-api-core", async () => ({
  authHeaders: async () => ({ Authorization: "Bearer jeton" }),
  readJson: async (response: Response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  },
}));
vi.mock("@/components/admin/AdminShell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/admin/AdminShell")>()),
  AdminShell: ({ children, title }: { children: ReactNode; title: string }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

// Le tableau des retours par vente a son propre test (AdminSaleFeedbackPanel.test.tsx).
vi.mock("@/components/admin/AdminSaleFeedbackPanel", () => ({
  AdminSaleFeedbackPanel: () => null,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

function renderPage(response: Response) {
  mocks.fetch.mockResolvedValue(response);
  vi.stubGlobal("fetch", mocks.fetch);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminPepitesPage />
    </QueryClientProvider>,
  );
}

const view: AdminPepitesView = {
  canSuspend: false,
  sections: [
    { id: "mode", title: "Mode : shadow", paragraphs: ["Observation."], alert: null, table: null },
    {
      id: "rate",
      title: "Taux de pépites",
      paragraphs: ["11,6 % des ventes évaluables."],
      alert: "Taux sous la plage d’alerte de 2 % à 15 %.",
      table: null,
    },
    {
      id: "list",
      title: "Pépites et presque pépites",
      paragraphs: [],
      alert: null,
      table: {
        caption: "Pépites, pépites à confirmer et presque pépites",
        head: ["Vente", "Mise à prix", "Critères"],
        rows: [
          [
            { t: "Appartement 3 pièces", h: "/sales/sale-1", s: "Pépite · Tribunal · Bordeaux" },
            { t: "80 000 €", s: "96 000 € à 160 000 €" },
            { t: "2 réussis, 1 manqué", bad: ["Manqué : Test B"], l: ["Surface enregistrée"] },
          ],
          [{ t: "Maison de ville" }, { t: "—" }, { t: "0 réussi, 0 manqué" }],
        ],
      },
    },
  ],
};

describe("page d'administration des pépites", () => {
  it("lit la page préparée par le serveur, avec le jeton de l'administrateur, sans cache", async () => {
    renderPage(Response.json(view));

    expect(await screen.findByText("Mode : shadow")).toBeTruthy();
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/admin/pepites",
      expect.objectContaining({
        headers: { Authorization: "Bearer jeton" },
        cache: "no-store",
      }),
    );
    expect(screen.getByText("Observation.")).toBeTruthy();
    // Pas de bouton pour changer de mode.
    expect(screen.queryByRole("button", { name: /mode|activer|ouvrir/i })).toBeNull();
  });

  it("précise sous les retours à quelle version de règle ils sont rattachés", async () => {
    renderPage(Response.json(view));

    expect(
      await screen.findByText(
        "Les retours sont rattachés à la version de règle en vigueur au moment de la lecture, pas à celle du clic.",
      ),
    ).toBeTruthy();
  });

  it("affiche une alerte quand la section en porte une", async () => {
    renderPage(Response.json(view));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Taux sous la plage d’alerte de 2 % à 15 %.");
  });

  it("affiche le tableau : en-têtes, ligne, lien vers la fiche, précisions et critères", async () => {
    renderPage(Response.json(view));

    const table = await screen.findByRole("table", {
      name: "Pépites, pépites à confirmer et presque pépites",
    });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((cell) => cell.textContent),
    ).toEqual(["Vente", "Mise à prix", "Critères"]);
    const link = within(table).getByRole("link", { name: "Appartement 3 pièces" });
    expect(link.getAttribute("href")).toBe("/sales/sale-1");
    const row = link.closest("tr") as HTMLElement;
    expect(within(row).getAllByRole("rowheader")).toHaveLength(1);
    expect(row.textContent).toContain("Pépite · Tribunal · Bordeaux");
    expect(row.textContent).toContain("96 000 € à 160 000 €");
    // Les critères : le manqué d'abord, en couleur d'alerte, puis les réussis.
    const items = within(row).getAllByRole("listitem", { hidden: true });
    expect(items.map((item) => item.textContent)).toEqual([
      "Manqué : Test B",
      "Surface enregistrée",
    ]);
    expect(items[0].className).toContain("text-danger");
    expect(items[1].className).not.toContain("text-danger");
  });

  describe("arrêt d'urgence", () => {
    it("n'affiche pas « Suspendre les pépites » hors du mode on", async () => {
      renderPage(Response.json(view));

      await screen.findByText("Mode : shadow");
      expect(screen.queryByRole("button", { name: "Suspendre les pépites" })).toBeNull();
    });

    it("l'affiche en mode on, demande confirmation puis repasse en shadow et relit la page", async () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      mocks.fetch
        .mockResolvedValueOnce(Response.json({ ...view, canSuspend: true }))
        .mockResolvedValueOnce(Response.json({ mode: "shadow" }))
        .mockResolvedValueOnce(Response.json(view));
      vi.stubGlobal("fetch", mocks.fetch);
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
        >
          <AdminPepitesPage />
        </QueryClientProvider>,
      );

      fireEvent.click(await screen.findByRole("button", { name: "Suspendre les pépites" }));

      await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(3));
      expect(confirm).toHaveBeenCalled();
      const [url, init] = mocks.fetch.mock.calls[1];
      expect(url).toBe("/api/admin/pepites");
      expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ mode: "shadow" }) });
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Suspendre les pépites" })).toBeNull(),
      );
    });

    it("ne fait rien si la confirmation est refusée", async () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      renderPage(Response.json({ ...view, canSuspend: true }));

      fireEvent.click(await screen.findByRole("button", { name: "Suspendre les pépites" }));

      expect(mocks.fetch).toHaveBeenCalledTimes(1);
    });
  });

  it("une cellule sans critères ni lien reste du simple texte", async () => {
    renderPage(Response.json(view));

    const cell = await screen.findByText("Maison de ville");
    expect(cell.closest("a")).toBeNull();
    expect(cell.closest("details")).toBeNull();
  });

  it("affiche l'erreur de lecture avec un bouton pour réessayer", async () => {
    renderPage(Response.json({ error: "Pépites indisponibles" }, { status: 500 }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Pépites indisponibles");
    expect(within(alert).getByRole("button", { name: "Réessayer" })).toBeTruthy();
  });

  it("dit que la page charge", () => {
    mocks.fetch.mockReturnValue(new Promise(() => undefined));
    vi.stubGlobal("fetch", mocks.fetch);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AdminPepitesPage />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("status").textContent).toContain("Chargement");
  });
});
