// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaleFeedbackBySale } from "@/lib/admin-sale-signal-feedback";
import { AdminSaleFeedbackPanel, saleFeedbackReasonLabel } from "./AdminSaleFeedbackPanel";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/client-api-core", () => ({
  authHeaders: async () => ({ Authorization: "Bearer jeton" }),
  readJson: async (response: Response) => {
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const SALE = "c7810000-1000-4000-8000-00000000000a";
const feedback: SaleFeedbackBySale = {
  generatedAt: "2026-11-10T12:00:00Z",
  windowDays: 90,
  measured: true,
  rows: [
    {
      saleId: SALE,
      title: "Appartement à Bordeaux",
      city: "Bordeaux",
      department: "33",
      signal: "pepite",
      reason: "criterion_wrong",
      count: 3,
      lastAt: "2026-11-09T10:00:00Z",
      ruleVersion: "pepite-v1",
    },
    {
      saleId: "c7810000-1000-4000-8000-00000000000b",
      title: "Maison à Lyon",
      city: "Lyon",
      department: "69",
      signal: "points_to_verify",
      reason: "point_wrong",
      count: 1,
      lastAt: null,
      ruleVersion: null,
    },
  ],
};

function renderPanel(response: Response, signals: Array<"pepite" | "points_to_verify">) {
  mocks.fetch.mockResolvedValue(response);
  vi.stubGlobal("fetch", mocks.fetch);
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <AdminSaleFeedbackPanel signals={signals} title="Retours par vente" />
    </QueryClientProvider>,
  );
}

describe("AdminSaleFeedbackPanel", () => {
  it("liste les retours négatifs de la pépite par vente, avec le motif et la version de la règle", async () => {
    renderPanel(Response.json(feedback), ["pepite"]);

    const table = await screen.findByRole("table", { name: "Retours par vente" });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "/api/admin/sale-feedback",
      expect.objectContaining({ headers: { Authorization: "Bearer jeton" }, cache: "no-store" }),
    );
    const rows = within(table).getAllByRole("row");
    // En-tête + la seule ligne du signal « pepite » (l'autre signal est sur la page Qualité).
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByRole("link", { name: "Appartement à Bordeaux" })).toBeTruthy();
    expect(rows[1].textContent).toContain("Un critère est faux");
    expect(rows[1].textContent).toContain("pepite-v1");
    expect(within(rows[1]).getByRole("link").getAttribute("href")).toBe(`/sales/${SALE}`);
    expect(within(table).getByRole("columnheader", { name: "Version de la règle" })).toBeTruthy();
  });

  it("ne montre pas la version de la règle pour les autres signaux", async () => {
    renderPanel(Response.json(feedback), ["points_to_verify"]);

    const table = await screen.findByRole("table", { name: "Retours par vente" });
    expect(within(table).getByText("Maison à Lyon")).toBeTruthy();
    expect(within(table).queryByRole("columnheader", { name: "Version de la règle" })).toBeNull();
  });

  it("dit « non mesuré » quand la fonction de base n'existe pas encore", async () => {
    renderPanel(Response.json({ generatedAt: null, windowDays: 90, rows: [], measured: false }), [
      "pepite",
    ]);
    expect(await screen.findByText(/non mesuré/)).toBeTruthy();
  });

  it("dit qu'il n'y a aucun retour négatif, sans tableau", async () => {
    renderPanel(Response.json({ ...feedback, rows: [] }), ["pepite"]);
    expect(await screen.findByText("Aucun retour négatif sur la période.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("affiche l'erreur de lecture", async () => {
    renderPanel(Response.json({ error: "Retours par vente indisponibles" }, { status: 500 }), [
      "pepite",
    ]);
    expect((await screen.findByRole("alert")).textContent).toBe("Retours par vente indisponibles");
  });
});

describe("saleFeedbackReasonLabel", () => {
  it("écrit le motif de la liste fermée, « Sans motif » ou rien d'inventé", () => {
    expect(saleFeedbackReasonLabel("point_wrong")).toBe("Un point est faux");
    expect(saleFeedbackReasonLabel("none")).toBe("Sans motif");
    expect(saleFeedbackReasonLabel("autre")).toBe("autre");
  });
});
