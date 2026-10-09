// @vitest-environment jsdom
import { buildStructuredDescription } from "@/lib/sale-description";
import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import type { AiReviewProjectionReadModel } from "@/lib/ai-review-guard";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import {
  ListingActions,
  ListingDescription,
  ListingLocation,
  ListingOverview,
  ListingPracticalDetails,
} from "./SaleListing";
import { ListingBudget } from "./ListingBudget";

vi.mock("@/components/FavoriteButton", () => ({
  FavoriteButton: () => <button>Suivre cette vente</button>,
}));
vi.mock("@/components/MapboxPreviewButton", () => ({
  MapboxPreviewButton: ({ label }: { label: string }) => <button>{label}</button>,
}));
vi.mock("@/components/MapThumbnail", () => ({ MapThumbnail: () => <div>Carte</div> }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const item = (values: Partial<AuctionSale> = {}): AuctionSale => ({ ...EXAMPLE_SALE, ...values });
const notary = () =>
  item({
    sale_venue_type: "notary",
    sale_legal_framework: "judicial_partition",
    sale_procedure: null,
    source_blocks: null,
    sale_verification_status: "verified",
    tribunal_name: "Stale court data",
    lawyer_name: "Étude du Centre",
  });

describe("readable listing sections", () => {
  it("does not promote a stale generated description over current dossier facts", () => {
    render(
      <ListingDescription
        sale={item({
          llm_display_description: "Visites programmées le 3 août. Libre de toute occupation.",
          occupancy_status: "rented",
          source_description: "Le logement est loué avec bail en cours.",
        })}
      />,
    );
    const section = screen.getByRole("region", { name: "Description" });
    expect(section.textContent).not.toContain("Visites programmées le 3 août");
    expect(section.textContent).not.toContain("Libre de toute occupation");
    expect(section.textContent).toContain("Loué");
    expect(
      screen.getByText("Afficher le texte de l’annonce source").closest("details")?.textContent,
    ).toContain("Le logement est loué avec bail en cours.");
  });

  it.each(["cancelled", "canceled", "postponed"])(
    "does not present stored dates as confirmed appointments for %s",
    (status) => {
      render(
        <ListingPracticalDetails sale={item({ status, sale_date: "2099-01-01T12:00:00Z" })} />,
      );
      expect(
        screen.getByText(
          status === "postponed" ? "Vente reportée · nouvelle date à confirmer" : "Vente annulée",
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          /Les dates conservées dans le dossier ne confirment pas un nouveau rendez-vous/,
        ),
      ).toBeTruthy();
    },
  );

  it("shows both boundaries of a multi-day bidding window in Paris time", () => {
    render(
      <ListingPracticalDetails
        sale={item({
          sale_procedure: {
            sale_window: {
              opens_at: "2026-09-16T13:00:00Z",
              closes_at: "2026-09-17T13:00:00Z",
            },
          },
        })}
      />,
    );
    expect(screen.getByText("Ouverture")).toBeTruthy();
    expect(screen.getByText("Clôture")).toBeTruthy();
    expect(screen.getByText(/16 septembre 2026/)).toBeTruthy();
    expect(screen.getByText(/17 septembre 2026/)).toBeTruthy();
  });
  it("keeps the visit slot visible and folds the full sale conditions", () => {
    const { container } = render(
      <ListingPracticalDetails
        sale={item({
          visit_dates: [
            "Visite le 4 septembre 2026 de 10 h à 11 h CONDITIONS DE LA VENTE Consulter le cahier auprès de l’avocat.",
          ],
        })}
      />,
    );
    expect(screen.getByText(/Visite le 4 septembre 2026 de 10 h à 11 h/)).toBeTruthy();
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Consulter le cahier auprès de l’avocat.");
    fireEvent.click(screen.getByText("Conditions de la source"));
    expect(details?.querySelector("p")?.textContent).toContain("CONDITIONS DE LA VENTE");
  });

  it("leads with the starting price and known essential facts", () => {
    render(<ListingOverview sale={item()} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("Bordeaux");
    expect(screen.getByText("42,6 m²")).toBeTruthy();
    expect(screen.getByText("Surface Carrez")).toBeTruthy();
    expect(screen.getByText("Chambres")).toBeTruthy();
    expect(screen.getByText("1", { exact: true })).toBeTruthy();
    expect(screen.getAllByRole("term")).toHaveLength(4);
    expect(screen.queryByText("Mise à prix au m²")).toBeNull();
    expect(screen.getByText("Prix de départ, hors frais")).toBeTruthy();
    expect(screen.getByRole("link", { name: /rendez-vous/i }).getAttribute("href")).toBe(
      "#rendez-vous",
    );
  });
  it("only adds the bedrooms fact when the count is a positive finite value", () => {
    const { container } = render(
      <ListingOverview sale={item({ bedrooms_count: 0, rooms_count: 2 })} />,
    );

    expect(within(container).queryByText("Chambres", { exact: true })).toBeNull();
    expect(screen.getAllByRole("term")).toHaveLength(3);
  });
  it("keeps AI-blocked room data from reappearing as bedrooms", () => {
    const projection: AiReviewProjectionReadModel = {
      auction_sale_id: "sale-1",
      field_key: "property.rooms_count",
      review_state: "unresolved",
      citation_status: "not_required",
      is_publishable: false,
      source_name: "Avoventes",
      source_url: "https://avoventes.fr/vente/1",
    };

    render(
      <ListingOverview
        sale={item({ rooms_count: 4, bedrooms_count: 2 })}
        aiReviewProjections={[projection]}
      />,
    );

    expect(screen.queryByText("4", { exact: true })).toBeNull();
    expect(screen.queryByText("2", { exact: true })).toBeNull();
    expect(screen.queryByText("Chambres", { exact: true })).toBeNull();
  });
  it("keeps the pricing scenario secondary and collapsed by default", () => {
    render(
      <ListingOverview
        sale={item()}
        scenarioSummary={{
          purchasePrice: 92_000,
          totalCost: 124_000,
          works: 20_000,
          marketValue: 150_000,
          personalized: false,
        }}
      />,
    );

    const summary = screen.getByText("Voir le scénario de prix");
    const details = summary.closest("details");
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(
      screen.getByText("Chambres").compareDocumentPosition(summary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByText("15 octobre 2026", { exact: false }).compareDocumentPosition(summary) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.click(summary);
    expect(details?.open).toBe(true);
    expect(screen.getByText("Coût du projet estimé")).toBeTruthy();
    expect(screen.getByText("Scénario de départ")).toBeTruthy();
  });
  it("uses the same collapsed disclosure for a personalized scenario", () => {
    render(
      <ListingOverview
        sale={item()}
        scenarioSummary={{
          purchasePrice: 100_000,
          totalCost: 132_000,
          works: 25_000,
          marketValue: null,
          personalized: true,
        }}
      />,
    );

    const summary = screen.getByText("Voir le scénario de prix");
    expect(summary.closest("details")?.open).toBe(false);
    fireEvent.click(summary);
    expect(screen.getByText("Votre scénario")).toBeTruthy();
  });
  it("shows a source explanation beside each key value without upgrading an unverified value", () => {
    render(
      <ListingOverview
        sale={item({
          occupancy_status: "vacant",
          source_checks: { canonical: { checked_at: "2026-09-12T10:00:00Z" } },
          source_conflicts: [
            { field: "occupancy_status", selected: "vacant", alternative: "rented" },
          ],
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Source à préciser pour Date de vente" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Source à préciser pour Mise à prix" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Source à préciser pour Surface Carrez" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Source à préciser pour Occupation" })).toBeTruthy();
  });

  it("labels a provisional surface as inferred in the real listing summary", () => {
    render(
      <ListingOverview
        sale={item({
          app_surface_m2: null,
          habitable_surface_m2: null,
          carrez_surface_m2: null,
          surface_evidence: null,
          rooms_count: 1,
        })}
      />,
    );

    expect(screen.getByText("Surface estimée")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voir l’origine de Surface Carrez" })).toBeTruthy();
  });

  it("suppresses AI-blocked type and rooms while retaining source provenance", () => {
    const projections: AiReviewProjectionReadModel[] = [
      {
        auction_sale_id: "sale-1",
        field_key: "property.property_type",
        review_state: "unresolved",
        citation_status: "not_required",
        is_publishable: false,
        source_name: "Avoventes",
        source_url: "https://avoventes.fr/vente/1",
      },
      {
        auction_sale_id: "sale-1",
        field_key: "property.rooms_count",
        review_state: "unverified",
        citation_status: "unverified",
        is_publishable: false,
        source_name: "Avoventes",
        source_url: "https://avoventes.fr/vente/1",
      },
    ];

    render(
      <ListingOverview
        sale={item({ property_type: "apartment", rooms_count: 4 })}
        aiReviewProjections={projections}
      />,
    );

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Type de bien à confirmer",
    );
    expect(screen.getByText("À confirmer")).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: /Source : Avoventes/ }).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("4", { exact: true })).toBeNull();
  });
  it("suppresses a blocked surface even when another raw surface field is present", () => {
    const projection: AiReviewProjectionReadModel = {
      auction_sale_id: "sale-1",
      field_key: "property.carrez_surface_m2",
      review_state: "unresolved",
      citation_status: "not_required",
      is_publishable: false,
      source_name: "Avoventes",
      source_url: "https://avoventes.fr/vente/1",
    };

    render(
      <ListingOverview
        sale={item({ app_surface_m2: null, habitable_surface_m2: null, carrez_surface_m2: 42.6 })}
        aiReviewProjections={[projection]}
      />,
    );

    expect(screen.getAllByText("À confirmer").length).toBeGreaterThan(0);
    expect(screen.queryByText("42,6 m²")).toBeNull();
    expect(screen.getByText(/Source : Avoventes/)).toBeTruthy();
    expect(screen.queryByRole("note", { name: /Surface :/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Surface/ })).toBeNull();
  });
  it("suppresses the price reliability badge when the AI review blocks the price", () => {
    const projection: AiReviewProjectionReadModel = {
      auction_sale_id: "sale-1",
      field_key: "sale.starting_price_eur",
      review_state: "unverified",
      citation_status: "unverified",
      is_publishable: false,
      source_name: "Avoventes",
      source_url: "https://avoventes.fr/vente/1",
    };

    render(<ListingOverview sale={item()} aiReviewProjections={[projection]} />);

    expect(screen.getByText("À confirmer")).toBeTruthy();
    expect(screen.queryByRole("note", { name: /Mise à prix :/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Mise à prix/ })).toBeNull();
  });
  it("does not expose premium or scenario values while a pricing input is protected", () => {
    const projection: AiReviewProjectionReadModel = {
      auction_sale_id: "sale-1",
      field_key: "sale.starting_price_eur",
      review_state: "unresolved",
      citation_status: "not_required",
      is_publishable: false,
      source_name: "Avoventes",
      source_url: "https://avoventes.fr/vente/1",
    };

    render(
      <ListingOverview
        sale={item()}
        premiumCeiling={120_000}
        aiReviewProjections={[projection]}
        scenarioSummary={{
          purchasePrice: 92_000,
          totalCost: 124_000,
          works: 20_000,
          marketValue: 150_000,
          personalized: false,
        }}
      />,
    );

    expect(screen.queryByText("Enchère plafond indicative")).toBeNull();
    expect(screen.queryByText("Voir le scénario de prix")).toBeNull();
  });
  it("does not show zero or invalid amounts as known property facts", () => {
    const { container } = render(
      <ListingOverview
        sale={item({
          app_surface_m2: null,
          carrez_surface_m2: null,
          habitable_surface_m2: null,
          starting_price_eur: 0,
          rooms_count: null,
          occupancy_status: null,
        })}
      />,
    );
    expect(screen.getAllByText("Non renseigné").length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain("0 €");
    expect(container.textContent).not.toContain("NaN");
  });
  it("labels absent listing facts without presenting them as pending review", () => {
    render(
      <ListingOverview
        sale={item({
          title: "Lot",
          property_type: "commercial",
          city: null,
          postal_code: null,
          sale_date: null,
          starting_price_eur: null,
          rooms_count: null,
          app_surface_m2: null,
          habitable_surface_m2: null,
          carrez_surface_m2: null,
          land_surface_m2: null,
        })}
      />,
    );
    expect(screen.getAllByText("Non renseignée").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Non renseigné").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Date non renseignée")).toBeTruthy();
    expect(screen.getByText("Localisation non renseignée")).toBeTruthy();
  });
  it("labels absent venue, visit and contact details explicitly", () => {
    render(
      <ListingPracticalDetails
        sale={item({
          sale_venue_type: "unknown",
          sale_procedure: null,
          source_blocks: null,
          sale_date: null,
          visit_dates: [],
          lawyer_name: null,
          lawyer_contact: null,
          tribunal: null,
          tribunal_name: null,
        })}
      />,
    );
    expect(screen.getByText("Lieu non renseigné")).toBeTruthy();
    expect(screen.getByText("Dates de visite non renseignées")).toBeTruthy();
    expect(screen.getByText("Contact non renseigné")).toBeTruthy();
    expect(screen.getByText("Date non renseignée")).toBeTruthy();
  });
  it("shows the actual visits and an actionable dossier contact", () => {
    render(<ListingPracticalDetails sale={item()} />);
    expect(screen.getByRole("heading").textContent).toBe("L’audience et les visites");
    expect(screen.getByText("2 octobre 2026 · 14:00")).toBeTruthy();
    expect(screen.getByText("7 octobre 2026 · 10:30")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "contact-demo@immojudis.fr" }).getAttribute("href"),
    ).toBe("mailto:contact-demo@immojudis.fr");
    expect(screen.getByText(/n’est pas automatiquement votre représentant/)).toBeTruthy();
  });
  it("does not call a notarial event a court hearing", () => {
    const { container } = render(<ListingPracticalDetails sale={notary()} />);
    expect(screen.getByRole("heading").textContent).toBe("La séance notariale et les visites");
    expect(screen.getByText("Étude ou organisateur")).toBeTruthy();
    expect(container.textContent).not.toContain("Stale court data");
    expect(container.textContent).not.toContain("Avocat poursuivant");
  });
  it("prioritizes the domanial procedure when no price is published", () => {
    const { container } = render(
      <ListingOverview
        sale={item({
          sale_venue_type: "state",
          sale_procedure: null,
          source_blocks: null,
          starting_price_eur: null,
          sale_date: null,
        })}
      />,
    );
    expect(screen.getByText("Cession domaniale")).toBeTruthy();
    expect(screen.getByText(/Prix non publié/)).toBeTruthy();
    expect(container.textContent).not.toContain("Prix de départ, hors frais");
    expect(screen.getByRole("link", { name: /procédure de cession/ }).getAttribute("href")).toBe(
      "#participation",
    );
  });
  it("provides the source text in a native disclosure and escapes its content", () => {
    const { container } = render(
      <ListingDescription
        sale={item({
          source_description: "<script>alert(1)</script>",
          source_url: "javascript:alert(1)",
        })}
      />,
    );
    expect(screen.queryByText(/Synthèse rédigée par IA/)).toBeNull();
    const disclosure = screen.getByText("Afficher le texte de l’annonce source").closest("details");
    expect(disclosure).toBeTruthy();
    expect(disclosure?.open).toBe(false);
    fireEvent.click(screen.getByText("Afficher le texte de l’annonce source"));
    expect(disclosure?.open).toBe(true);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: /Consulter l’annonce source/ })).toBeNull();
  });
  it("does not repeat identical source and display descriptions", () => {
    const { container } = render(
      <ListingDescription
        sale={item({ source_description: buildStructuredDescription(item()) })}
      />,
    );
    expect(container.querySelectorAll("details")).toHaveLength(1);
  });
  it("labels the generated description as a fiche synthesis", () => {
    render(
      <ListingDescription
        sale={item({
          llm_display_description: null,
          about_description: null,
          source_description: null,
          description: null,
        })}
      />,
    );
    expect(screen.getByText(/Synthèse issue des données de la fiche/)).toBeTruthy();
    expect(screen.getByText(/ne remplace pas le texte source/)).toBeTruthy();
  });
  it("does not invent a location or offer a broken map interaction", () => {
    render(<ListingLocation sale={item({ latitude: NaN })} />);
    expect(screen.queryByText("Carte")).toBeNull();
    expect(screen.queryByRole("button", { name: "Explorer le quartier" })).toBeNull();
    expect(screen.getByText(/lorsque les coordonnées/)).toBeTruthy();
  });
  it("uses the existing map when coordinates exist", () => {
    render(<ListingLocation sale={item()} />);
    expect(screen.getByText("Carte")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Explorer le quartier" })).toBeTruthy();
    expect(screen.getByText(/Localisation indicative/)).toBeTruthy();
  });
});

describe("budget preparation", () => {
  it("does not label incomplete inputs as a total or assume a flat fee percentage", () => {
    const { container } = render(<ListingBudget sale={item()} />);
    fireEvent.click(screen.getByText("Simuler mon budget"));
    expect(container.textContent).not.toContain("8–12");
    expect(screen.getByRole("status").textContent).toContain("budget incomplet");
    expect(screen.queryByText("Total de vos hypothèses")).toBeNull();
    fireEvent.change(screen.getByLabelText("Ensemble des frais d’acquisition (€)"), {
      target: { value: "8 000" },
    });
    expect(screen.getByRole("status").textContent).toContain("budget incomplet");
    fireEvent.change(screen.getByLabelText("Travaux et autres dépenses (€)"), {
      target: { value: "20 000" },
    });
    expect(screen.getByRole("status").textContent).toContain("Total de vos hypothèses");
    expect(screen.getByRole("status").textContent?.replace(/\s/g, "")).toContain("120000€");
    fireEvent.change(screen.getByLabelText("Ensemble des frais d’acquisition (€)"), {
      target: { value: "-8" },
    });
    expect(
      screen.getByLabelText("Ensemble des frais d’acquisition (€)").getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("budget incomplet");
  });
  it("accepts an explicit zero works budget, never a zero purchase price", () => {
    render(<ListingBudget sale={item()} />);
    fireEvent.click(screen.getByText("Simuler mon budget"));
    fireEvent.change(screen.getByLabelText("Ensemble des frais d’acquisition (€)"), {
      target: { value: "8000" },
    });
    fireEvent.change(screen.getByLabelText("Travaux et autres dépenses (€)"), {
      target: { value: "0" },
    });
    expect(screen.getByText("Total de vos hypothèses")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Prix d’achat envisagé (€)"), {
      target: { value: "0" },
    });
    expect(screen.getByRole("status").textContent).toContain("Prix d’achat à renseigner");
  });
  it("adapts fee categories to notarial sales", () => {
    const { container } = render(<ListingBudget sale={notary()} />);
    expect(screen.getByText("Notaire")).toBeTruthy();
    expect(container.textContent).not.toContain("Avocat");
    expect(screen.getByRole("link", { name: /conditions de vente/ }).getAttribute("href")).toBe(
      "#participation",
    );
  });
  it("does not turn an absent starting price into zero", () => {
    render(<ListingBudget sale={item({ starting_price_eur: null })} />);
    fireEvent.click(screen.getByText("Simuler mon budget"));
    expect(screen.getByText("Budget à compléter")).toBeTruthy();
    expect(within(screen.getByRole("status")).getByText("Prix d’achat à renseigner")).toBeTruthy();
  });
});

describe("listing actions", () => {
  it("copies a clean URL without the return-search state", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<ListingActions sale={item()} publicDemo />);
    fireEvent.click(screen.getByRole("button", { name: "Partager cette annonce" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).not.toContain("from=");
    expect(screen.queryByRole("button", { name: "Suivre cette vente" })).toBeNull();
  });
  it("only mounts favorites for a real persisted sale", () => {
    render(<ListingActions sale={item({ id: "11111111-1111-4111-8111-111111111111" })} />);
    expect(screen.getByRole("button", { name: "Suivre cette vente" })).toBeTruthy();
  });
});
