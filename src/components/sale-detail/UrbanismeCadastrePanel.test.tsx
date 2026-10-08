// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { UrbanismeCadastrePanel } from "./UrbanismeCadastrePanel";

vi.mock("./CadastralNeighborhoodMap", () => ({
  CadastralNeighborhoodMap: ({
    lat,
    lng,
    pointKind,
    address,
  }: {
    lat: number;
    lng: number;
    pointKind: string;
    address: string;
  }) => (
    <div
      data-testid="cadastral-neighborhood-map"
      data-lat={String(lat)}
      data-lng={String(lng)}
      data-point-kind={pointKind}
      data-address={address}
    />
  ),
}));

afterEach(() => cleanup());

const sale = (values: Partial<AuctionSale> = {}): AuctionSale =>
  ({
    ...EXAMPLE_SALE,
    ...values,
  }) as AuctionSale;

describe("UrbanismeCadastrePanel", () => {
  it("garde le point d’adresse original pour le plan quand les champs affichés sont masqués", () => {
    const mapLocation = sale({
      address: "12 rue des Fleurs",
      postal_code: "33000",
      city: "Bordeaux",
      latitude: 44.842748,
      longitude: -0.586227,
    });

    render(
      <UrbanismeCadastrePanel
        sale={sale({
          address: null,
          postal_code: null,
          city: null,
          latitude: null,
          longitude: null,
        })}
        mapLocation={mapLocation}
      />,
    );

    const map = screen.getByTestId("cadastral-neighborhood-map");
    expect(map.getAttribute("data-lat")).toBe("44.842748");
    expect(map.getAttribute("data-lng")).toBe("-0.586227");
    expect(map.getAttribute("data-point-kind")).toBe("listing");
    expect(map.getAttribute("data-address")).toBe("12 rue des Fleurs, 33000 Bordeaux");
  });

  it("renders explicit unavailable states without tabs, legal conclusions, or a fake plan", () => {
    const { container } = render(
      <UrbanismeCadastrePanel
        sale={sale({
          title: "Bien sans rattachement cadastral",
          description: null,
          source_description: null,
          source_blocks: null,
          source_blocks_by_source: null,
          documents_rich: [],
          risks: [],
          land_surface_m2: null,
          latitude: null,
          longitude: null,
        })}
      />,
    );

    expect(screen.getByRole("heading", { name: "Urbanisme & cadastre" })).toBeTruthy();
    expect(screen.getByText(/parcelle à rattacher/i)).toBeTruthy();
    expect(screen.getByText(/L’adresse est un point de départ/)).toBeTruthy();
    expect(screen.getByText("Plan cadastral du quartier")).toBeTruthy();
    const details = screen.getByText("Voir les références et contrôles").closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.querySelectorAll("details")).toHaveLength(0);
    fireEvent.click(screen.getByText("Voir les références et contrôles"));
    expect(screen.getByText(/Aucun risque urbanisme \/ foncier/)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).not.toContain("constructible");
    expect(container.textContent).not.toContain("droit à construire");
  });

  it("shows sourced parcel and risk details while keeping PLU statements to verify", () => {
    const { container } = render(
      <UrbanismeCadastrePanel
        sale={sale({
          address: null,
          source_blocks: null,
          documents_rich: [
            {
              url: "https://documents.example.test/plan-cadastral.pdf",
              label: "Plan cadastral source",
              type: "cadastre",
              document_type: "cadastre",
              extraction_status: "complete",
            },
          ],
          risks: [
            {
              risk_type: "flood_zone",
              risk_label: "Zone inondable à vérifier",
              severity: 3,
              evidence: "Mention d'une zone inondable dans le dossier source.",
              occurrences: [
                {
                  document_url: "https://documents.example.test/erp.pdf",
                  document_label: "État des risques",
                  document_type: "erp",
                  page_number: 2,
                  excerpt: "Zone inondable à confirmer.",
                  confidence: 0.8,
                },
              ],
            },
          ],
        })}
        cadastralParcels={[
          {
            parcelKey: "33063-AB-123",
            parcelId: "33063AB123",
            codeInsee: "33063",
            department: "33",
            city: "Bordeaux",
            section: "AB",
            parcelNumber: "123",
            surfaceM2: 480,
            centroidLat: 44.842748,
            centroidLng: -0.586227,
            matchKind: "point_intersection",
            confidence: 0.92,
            sourceApi: "API Carto Cadastre",
          },
        ]}
        urbanPlanningSignals={[
          {
            signalKey: "plu-zone",
            signalKind: "zoning",
            label: "Zonage PLU à confirmer",
            status: "to_verify",
            priority: "medium",
            sourceName: "PLU communal",
            sourceKind: "official_document",
            documentUrl: "https://documents.example.test/plu.pdf",
            documentLabel: "Règlement PLU",
            documentType: "plu",
            pageNumber: 4,
            excerpt: "Le règlement de zone doit être consulté.",
            action: "Contrôler la règle opposable.",
            confidence: 0.7,
          },
        ]}
      />,
    );

    expect(screen.getByText("Référence cadastrale à recouper")).toBeTruthy();
    expect(screen.getByText("Plan cadastral du quartier")).toBeTruthy();
    const details = screen.getByText("Voir les références et contrôles").closest("details");
    expect(details?.open).toBe(false);
    fireEvent.click(screen.getByText("Voir les références et contrôles"));
    expect(screen.getByText("Section AB n° 123")).toBeTruthy();
    expect(screen.getAllByText(/à recouper/i).length).toBeGreaterThan(0);
    expect(screen.getByText("Point géocodé · à recouper")).toBeTruthy();
    expect(screen.getByText("Zonage PLU à confirmer")).toBeTruthy();
    expect(screen.getAllByText("Zone inondable à vérifier").length).toBeGreaterThan(0);
    expect(screen.getByText(/ne délimite pas une parcelle/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Géoportail de l’urbanisme/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Cadastre\.gouv\.fr/ })).toBeTruthy();
    expect(container.textContent).toContain("À vérifier");
    expect(container.textContent).not.toContain("est constructible");
    expect(container.textContent).not.toContain("autorisation de construire");
  });
});
