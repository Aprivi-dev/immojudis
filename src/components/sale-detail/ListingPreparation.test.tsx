// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { ListingPreparation } from "./ListingPreparation";
import { getListingCompleteness } from "@/lib/listing-completeness";

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

    const score = Math.round(getListingCompleteness(item).completenessScore);
    expect(screen.getByLabelText(`Niveau de détail du dossier : ${score} %`)).toBeTruthy();
    expect(screen.getByText("9 des 12 informations essentielles sont présentes.")).toBeTruthy();
    const missing = screen.getByText("Surface publiée · Dates de visite · Pièces du dossier");
    expect(missing.closest("details")).toBeNull();
    expect(container.querySelectorAll("details details")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Compléter mon dossier/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Surface publiée — non renseigné")).toBeTruthy();
    expect(screen.getByText("Dates de visite — non renseigné")).toBeTruthy();
    expect(screen.getByText("Pièces du dossier — non renseigné")).toBeTruthy();
    expect(screen.getByText(/ne vaut pas validation/)).toBeTruthy();
  });

  it("includes unknown occupation and unconfirmed facts in the checklist and request", () => {
    render(<ListingPreparation sale={sale({ occupancy_status: "unknown" })} />);
    fireEvent.click(screen.getByRole("button", { name: /Compléter mon dossier/i }));
    expect(screen.getByText(/Occupation du bien — non renseigné/)).toBeTruthy();
    expect(screen.getByText(/Prix de départ.*— non vérifié/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    fireEvent.click(screen.getByRole("button", { name: /Préparer une demande/i }));
    const message = screen.getByRole("textbox", {
      name: "Message prêt à copier",
    }) as HTMLTextAreaElement;
    expect(message.value).toContain("Occupation du bien");
    expect(message.value).toContain("Prix de départ / mise à prix");
  });

  it("stores only the optional personal note locally", async () => {
    const storage = installLocalStorage();
    const item = sale({ id: "sale-local-note" });
    render(<ListingPreparation sale={item} ownerId="owner-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Compléter mon dossier/i }));
    const note = screen.getByLabelText(/Votre note personnelle/i);
    fireEvent.change(note, { target: { value: "Demander le DPE" } });
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer ma note" }));

    await waitFor(() => expect(screen.getByText(/Note enregistrée/)).toBeTruthy());
    expect(storage.getItem("immojudis:listing-personal-note:owner-1:sale-local-note")).toBe(
      "Demander le DPE",
    );
  });

  it("keeps personal notes isolated by account", async () => {
    const storage = installLocalStorage();
    storage.setItem("immojudis:listing-personal-note:owner-a:sale-account-scope", "Private note");
    render(<ListingPreparation sale={sale({ id: "sale-account-scope" })} ownerId="owner-b" />);

    fireEvent.click(screen.getByRole("button", { name: /Compléter mon dossier/i }));
    await waitFor(() => {
      expect((screen.getByLabelText(/Votre note personnelle/i) as HTMLTextAreaElement).value).toBe(
        "",
      );
    });
    expect(
      (screen.getByLabelText(/Votre note personnelle/i) as HTMLTextAreaElement).value,
    ).not.toBe("Private note");
  });

  it("builds a copyable request from missing fields and reports clipboard failures", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ListingPreparation sale={sale({ city: "Bordeaux" })} />);

    fireEvent.click(screen.getByRole("button", { name: /Préparer une demande/i }));
    const message = screen.getByRole("textbox", { name: "Message prêt à copier" });
    expect((message as HTMLTextAreaElement).value).toContain("Localisation publiée :");
    expect((message as HTMLTextAreaElement).value).toContain("Merci par avance");
    const editedMessage = "Bonjour,\n\nJe souhaite confirmer le DPE et la prochaine visite.";
    fireEvent.change(message, { target: { value: editedMessage } });
    fireEvent.click(screen.getByRole("button", { name: /Copier le message/i }));

    await waitFor(() => expect(screen.getByText(/Copie automatique indisponible/)).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(editedMessage);
  });
});
