// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { ListingChecks, ListingPreparation } from "./ListingPreparation";

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

describe("signalement depuis la fiche complète", () => {
  const SALE_ID = "4655881c-249d-4eab-beba-f2624d8a1af0";

  it("propose de signaler une erreur sur la fiche et sur le plafond, avec l'identifiant de la vente", () => {
    render(<ListingChecks sale={sale()} points={[]} saleId={SALE_ID} />);

    const fiche = screen.getByRole("link", { name: "Signaler une erreur sur cette fiche" });
    expect(fiche.getAttribute("href")).toBe(
      `/contact?sujet=erreur&vente=${SALE_ID}&rubrique=fiche`,
    );
    const plafond = screen.getByRole("link", { name: "Signaler une erreur sur le plafond" });
    expect(plafond.getAttribute("href")).toBe(
      `/contact?sujet=erreur&vente=${SALE_ID}&rubrique=plafond`,
    );
  });

  it("ne propose rien sans identifiant de vente", () => {
    render(<ListingChecks sale={sale()} points={[]} />);
    expect(screen.queryByRole("link", { name: /Signaler/ })).toBeNull();
  });
});

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
    const { container } = render(
      <>
        <ListingChecks sale={item} points={[]} />
        <ListingPreparation sale={item} />
      </>,
    );

    expect(screen.getByRole("heading", { name: "Ce que nous savons de ce bien" })).toBeTruthy();
    expect(screen.getByLabelText("Bilan des informations du bien")).toBeTruthy();
    expect(screen.queryByLabelText(/Niveau de détail/)).toBeNull();
    expect(container.textContent).not.toContain("130 critères");
    expect(container.textContent).not.toContain("12 informations essentielles");
    expect(screen.getByRole("heading", { name: "À vérifier avant d’enchérir" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Voir les .* informations à compléter/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/Surface.*information manquante/);
    expect(dialog.textContent).toMatch(/[Vv]isite.*information manquante/);
    expect(item.habitable_surface_m2).toBeNull();
    expect(item.visit_dates).toEqual([]);
  });

  it("does not expose the end-user email draft workflow", () => {
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ListingChecks sale={sale({ occupancy_status: "unknown" })} points={[]} />);

    expect(screen.queryByRole("button", { name: /Préparer une demande/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message prêt à copier" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Copier le message/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Voir les .* informations à compléter/ }),
    ).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("stores only the optional personal note locally", async () => {
    const storage = installLocalStorage();
    const item = sale({ id: "sale-local-note" });
    render(<ListingChecks sale={item} points={[]} ownerId="owner-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Voir les .* informations|Mes notes/ }));
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
    render(
      <ListingChecks sale={sale({ id: "sale-account-scope" })} points={[]} ownerId="owner-b" />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Voir les .* informations|Mes notes/ }));
    await waitFor(() => {
      expect((screen.getByLabelText(/Votre note personnelle/i) as HTMLTextAreaElement).value).toBe(
        "",
      );
    });
    expect(
      (screen.getByLabelText(/Votre note personnelle/i) as HTMLTextAreaElement).value,
    ).not.toBe("Private note");
  });

  it("gathers the listing points, the file's points and the missing essentials in one block", () => {
    const item = sale({
      occupancy_status: "unknown",
      risks: [
        {
          risk_type: "occupation_to_confirm",
          risk_label: "Occupation à confirmer",
          severity: 3,
        } as NonNullable<AuctionSale["risks"]>[number],
      ],
    });
    render(
      <ListingChecks
        sale={item}
        points={[{ key: "occupancy", label: "Occupation du bien à vérifier" }]}
        showRisks
        preparation={{ href: "#calculation", label: "Préparer mon enchère" }}
      />,
    );

    const block = screen.getByRole("region", { name: "À vérifier avant d’enchérir" });
    expect(block.id).toBe("points-a-verifier");
    // Le point relevé dans les pièces dit déjà ce que dit la pastille : pas de doublon.
    expect(screen.getAllByText("Occupation à confirmer").length).toBeGreaterThan(0);
    expect(screen.queryByText("Occupation du bien à vérifier")).toBeNull();
    expect(screen.getByText(/Ces points sont ceux que l’annonce laisse ouverts/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Préparer mon enchère" }).getAttribute("href")).toBe(
      "#calculation",
    );
  });

  it("keeps the file's points to the Analyse offer", () => {
    const item = sale({
      risks: [
        {
          risk_type: "works_to_price",
          risk_label: "Travaux à chiffrer",
          severity: 2,
        } as NonNullable<AuctionSale["risks"]>[number],
      ],
    });
    render(<ListingChecks sale={item} points={[]} />);

    expect(screen.queryByText("Travaux à chiffrer")).toBeNull();
  });
});
