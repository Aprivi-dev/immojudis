// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { LawyerQuestions } from "./LawyerQuestions";

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Appartement T3 à Bordeaux",
    property_type: "apartment",
    city: "Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    sale_venue_type: "tribunal",
    sale_date: "2026-12-14T09:00:00.000Z",
    starting_price_eur: 85_000,
    documents: null,
    documents_rich: null,
    media: null,
    visit_dates: null,
    occupancy_status: null,
    app_surface_m2: null,
    habitable_surface_m2: null,
    carrez_surface_m2: null,
    land_surface_m2: null,
    sale_procedure: null,
    ...overrides,
  } as AuctionSale;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LawyerQuestions (Mes questions pour l'avocat)", () => {
  it("liste les questions tirées de la fiche, sans rien envoyer", () => {
    render(<LawyerQuestions sale={sale()} />);

    expect(screen.getByRole("heading", { name: "Mes questions pour l’avocat" })).toBeTruthy();
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(2);
    expect(screen.getByText(/Rien n’est envoyé/)).toBeTruthy();
    expect(screen.getAllByText(/^Dans la fiche : /).length).toBe(items.length);
    expect(document.body.textContent).toContain("Pièces du dossier");
  });

  it("copie la liste numérotée et le dit dans une région vivante", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<LawyerQuestions sale={sale()} />);

    fireEvent.click(screen.getByRole("button", { name: "Copier la liste" }));

    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Liste copiée."));
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied.startsWith("Mes questions pour l’avocat\n\n1. ")).toBe(true);
    expect(copied).not.toMatch(/\bnous\b/);
  });

  it("dit que la copie a échoué quand le navigateur la refuse", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("refusé")) },
      configurable: true,
    });
    render(<LawyerQuestions sale={sale()} />);

    fireEvent.click(screen.getByRole("button", { name: "Copier la liste" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Copie impossible/));
  });

  it("imprime la liste seule : le reste de la page est masqué à l'impression", () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const { container } = render(<LawyerQuestions sale={sale()} />);

    fireEvent.click(screen.getByRole("button", { name: "Imprimer" }));

    expect(print).toHaveBeenCalledOnce();
    expect(container.querySelector("section")?.id).toBe("questions-avocat");
    const style = container.querySelector("style")?.textContent ?? "";
    expect(style).toContain("@media print");
    expect(style).toContain(":not(:has(#questions-avocat))");
    // Les boutons ne sortent pas sur le papier.
    expect(screen.getByRole("button", { name: "Imprimer" }).parentElement?.className).toContain(
      "print:hidden",
    );
  });
});
