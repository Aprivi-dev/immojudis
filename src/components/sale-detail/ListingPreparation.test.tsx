// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { ListingPreparation } from "./ListingPreparation";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function installLocalStorage() {
  const values = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  return storage;
}

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    documents: [],
    documents_rich: [],
    occupancy_status: "vacant",
    source_url: "https://source.example/annonce",
    ...overrides,
  };
}

describe("ListingPreparation", () => {
  it("exposes the real missing-field checklist without changing sale data", () => {
    const item = sale({
      habitable_surface_m2: null,
      carrez_surface_m2: null,
      app_surface_m2: null,
      land_surface_m2: null,
      visit_dates: [],
      documents: [],
      documents_rich: [],
    });
    const { container } = render(<ListingPreparation sale={item} />);

    expect(screen.getByRole("heading", { name: "Ce que nous savons de ce bien" })).toBeTruthy();
    expect(screen.getByLabelText("Bilan des informations du bien")).toBeTruthy();
    expect(screen.queryByLabelText(/Niveau de détail/)).toBeNull();
    expect(container.textContent).not.toContain("130 critères");
    expect(container.textContent).not.toContain("12 informations essentielles");
    expect(screen.getByRole("heading", { name: "Ce qu’il reste à connaître" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Voir les .* points/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/Surface.*information manquante/);
    expect(dialog.textContent).toMatch(/[Vv]isite.*information manquante/);
    expect(item.habitable_surface_m2).toBeNull();
    expect(item.visit_dates).toEqual([]);
  });

  it("does not expose the end-user email draft workflow", () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ListingPreparation sale={sale({ occupancy_status: "unknown" })} publicDemo />);

    expect(screen.queryByRole("button", { name: /Préparer une demande/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message prêt à copier" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copier le message/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Voir les .* points/ })).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("stores only the optional personal note locally", async () => {
    const storage = installLocalStorage();
    const item = sale({ id: "sale-local-note" });
    render(<ListingPreparation sale={item} ownerId="owner-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Voir les .* points|Mes notes/ }));
    const note = screen.getByLabelText(/Votre note personnelle/i);
    fireEvent.change(note, { target: { value: "Demander le DPE" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer ma note" }));

    await waitFor(() => expect(screen.getByText(/Note enregistrée/)).toBeTruthy());
    expect(storage.getItem("immojudis:listing-personal-note:owner-1:sale-local-note")).toBe(
      "Demander le DPE",
    );
  });

  it("keeps values awaiting review out of the public information grid", () => {
    const { container } = render(
      <ListingPreparation
        sale={sale({ bedrooms_count: 3 })}
        aiReviewProjections={[
          "property.rooms_count",
          "property.carrez_surface_m2",
          "sale.starting_price_eur",
        ].map((field_key) => ({
          auction_sale_id: EXAMPLE_SALE.id,
          field_key,
          review_state: "unresolved" as const,
          citation_status: "unverified" as const,
          is_publishable: false,
          source_name: null,
          source_url: null,
        }))}
        aiReviewStatus="ready"
      />,
    );

    expect(container.textContent).not.toContain("3 chambres");
    expect(container.textContent).not.toContain("42,6 m²");
    expect(container.textContent).not.toContain("92 000");
    expect(screen.getAllByText("À confirmer").length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox", { name: "Message prêt à copier" })).toBeNull();
  });

  it("keeps personal notes isolated by account", async () => {
    const storage = installLocalStorage();
    storage.setItem("immojudis:listing-personal-note:owner-a:sale-account-scope", "Private note");
    render(<ListingPreparation sale={sale({ id: "sale-account-scope" })} ownerId="owner-b" />);

    fireEvent.click(screen.getByRole("button", { name: /Voir les .* points|Mes notes/ }));
    await waitFor(() => {
      expect((screen.getByLabelText(/Votre note personnelle/i) as HTMLTextAreaElement).value).toBe(
        "",
      );
    });
    expect(
      (screen.getByLabelText(/Votre note personnelle/i) as HTMLTextAreaElement).value,
    ).not.toBe("Private note");
  });
});
