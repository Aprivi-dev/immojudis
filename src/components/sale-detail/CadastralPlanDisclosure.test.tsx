// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CadastralNeighborhoodPoint } from "@/lib/cadastre-neighborhood";

const geocodeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/cadastre-neighborhood", () => ({
  geocodeCadastralNeighborhood: geocodeMock,
}));

vi.mock("./CadastralNeighborhoodMap", () => ({
  CadastralNeighborhoodMap: ({
    lat,
    lng,
    pointKind,
    address,
    outlines,
  }: {
    lat: number;
    lng: number;
    pointKind: string;
    address: string;
    outlines?: { outlines: unknown[] } | null;
  }) => (
    <div
      data-testid="cadastral-neighborhood-map"
      data-outlines={String(outlines?.outlines.length ?? 0)}
      data-lat={String(lat)}
      data-lng={String(lng)}
      data-point-kind={pointKind}
      data-address={address}
    />
  ),
}));

import { CadastralPlanDisclosure } from "./CadastralPlanDisclosure";

afterEach(() => cleanup());

beforeEach(() => {
  geocodeMock.mockReset();
});

const point = (overrides: Partial<CadastralNeighborhoodPoint> = {}): CadastralNeighborhoodPoint =>
  ({
    lat: 44.842748,
    lng: -0.586227,
    source: "Adresse géocodée par l’IGN",
    kind: "address",
    ...overrides,
  }) as CadastralNeighborhoodPoint;

const renderDisclosure = (values: Partial<Parameters<typeof CadastralPlanDisclosure>[0]> = {}) =>
  render(
    <CadastralPlanDisclosure
      point={null}
      streetAddress="12 rue des Fleurs"
      displayAddress="12 rue des Fleurs, 33000 Bordeaux"
      postalCode="33000"
      city="Bordeaux"
      {...values}
    />,
  );

describe("CadastralPlanDisclosure", () => {
  it("affiche immédiatement un point fourni sans interaction ni géocodage", () => {
    renderDisclosure({
      point: point({ kind: "listing", source: "Coordonnées de l’annonce" }),
    });

    const map = screen.getByTestId("cadastral-neighborhood-map");
    expect(map.getAttribute("data-lat")).toBe("44.842748");
    expect(map.getAttribute("data-lng")).toBe("-0.586227");
    expect(map.getAttribute("data-point-kind")).toBe("listing");
    expect(geocodeMock).not.toHaveBeenCalled();
  });

  it("géocode automatiquement l’adresse puis recommence pour une nouvelle adresse", async () => {
    geocodeMock.mockResolvedValueOnce(point());
    const view = renderDisclosure();

    await waitFor(() => expect(screen.getByTestId("cadastral-neighborhood-map")).toBeTruthy());
    expect(geocodeMock).toHaveBeenCalledTimes(1);
    expect(geocodeMock.mock.calls[0]?.[0]).toEqual({
      address: "12 rue des Fleurs",
      postalCode: "33000",
      city: "Bordeaux",
    });

    geocodeMock.mockResolvedValueOnce(
      point({ lat: 44.843, lng: -0.587, source: "Adresse géocodée par l’IGN" }),
    );
    view.rerender(
      <CadastralPlanDisclosure
        point={null}
        streetAddress="14 rue des Fleurs"
        displayAddress="14 rue des Fleurs, 33000 Bordeaux"
        postalCode="33000"
        city="Bordeaux"
      />,
    );

    await waitFor(() => expect(geocodeMock).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByTestId("cadastral-neighborhood-map").getAttribute("data-lat")).toBe(
        "44.843",
      ),
    );
    expect(geocodeMock.mock.calls[1]?.[0]).toEqual({
      address: "14 rue des Fleurs",
      postalCode: "33000",
      city: "Bordeaux",
    });
  });

  it("affiche un état vide après échec et permet de réessayer", async () => {
    geocodeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(point());
    renderDisclosure();

    await waitFor(() => expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy());
    expect(screen.getByRole("status").textContent).toMatch(/ne peut pas être centré/i);

    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));

    await waitFor(() => expect(screen.getByTestId("cadastral-neighborhood-map")).toBeTruthy());
    expect(geocodeMock).toHaveBeenCalledTimes(2);
  });

  it("cadre le plan sur la parcelle citée par l’annonce plutôt que sur le centre du village", () => {
    renderDisclosure({
      point: point({ lat: 47.281127, lng: 4.676462, kind: "address" }),
      parcels: {
        outlines: [
          {
            id: "21238000ZA0092",
            label: "Section ZA n° 92",
            confirmed: true,
            geometry: {
              type: "Polygon",
              coordinates: [
                [
                  [4.66, 47.27],
                  [4.662, 47.27],
                  [4.662, 47.272],
                  [4.66, 47.27],
                ],
              ],
            },
          },
        ],
        bounds: [
          [4.66, 47.27],
          [4.662, 47.272],
        ],
        center: { lat: 47.271, lng: 4.661 },
        confirmed: true,
      },
    });

    const map = screen.getByTestId("cadastral-neighborhood-map");
    expect(map.getAttribute("data-lat")).toBe("47.271");
    expect(map.getAttribute("data-point-kind")).toBe("parcel-centroid");
    expect(map.getAttribute("data-outlines")).toBe("1");
    expect(screen.getByText(/Contour plein : parcelle citée dans l’annonce/)).toBeTruthy();
    expect(screen.queryByText(/Le point situe le quartier/)).toBeNull();
    expect(geocodeMock).not.toHaveBeenCalled();
  });
});
