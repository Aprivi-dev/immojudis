// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { AuctionSale } from "@/lib/types";
import { SaleVisual } from "./SaleVisual";

describe("SaleVisual", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("utilise le satellite Mapbox comme visuel principal lorsqu'une adresse est géolocalisée", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

    render(
      <SaleVisual
        sale={saleWithMedia("https://images.example.test/photo-cassee.jpg")}
        title="Appartement à Nice"
      />,
    );

    const satellite = screen.getByRole("img", {
      name: "Vue aérienne de Appartement à Nice",
    });
    expect(satellite.getAttribute("src")).toContain("/mapbox/satellite-v9/static/");

    fireEvent.load(satellite);
    expect(await screen.findByText("Vue aérienne Mapbox")).toBeTruthy();
  });

  it("garde un seul @2x en 896×672 hors vignette de liste", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

    render(<SaleVisual sale={saleWithMedia("https://images.example.test/p.jpg")} title="Maison" />);

    const satellite = screen.getByRole("img", { name: "Vue aérienne de Maison" });
    expect(satellite.getAttribute("src")).toContain(",17/896x672@2x?");
    expect(satellite.getAttribute("srcset")).toBeNull();
  });

  it("demande la vignette satellite de liste en 400×300, @2x seulement via srcset, à cadrage constant", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

    render(
      <SaleVisual
        sale={saleWithMedia("https://images.example.test/p.jpg")}
        title="Maison"
        thumbnail
        mapWidth={400}
        mapHeight={300}
        mapFramingWidth={512}
      />,
    );

    const satellite = screen.getByRole("img", { name: "Vue aérienne de Maison" });
    // 17 - log2(512 / 400) = 16,64 : la zone visible est celle de l'ancien 512×384.
    expect(satellite.getAttribute("src")).toContain(",16.64/400x300?access_token=");
    expect(satellite.getAttribute("src")).not.toContain("@2x");
    const srcSet = satellite.getAttribute("srcset") ?? "";
    const [oneX, twoX] = srcSet.split(", ");
    expect(oneX).toBe(`${satellite.getAttribute("src")} 1x`);
    expect(twoX).toContain(",16.64/400x300@2x?access_token=");
    expect(twoX).toMatch(/ 2x$/);
    // Le satellite est déjà du JPEG chez Mapbox : aucun format imposé.
    expect(srcSet).not.toContain(".webp");
  });

  it("sert la carte du secteur des vignettes de liste en WebP natif Mapbox", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

    render(
      <SaleVisual
        sale={{ ...saleWithMedia("https://images.example.test/p.jpg"), address: null }}
        title="Terrain"
        thumbnail
        mapWidth={400}
        mapHeight={300}
        mapFramingWidth={512}
      />,
    );

    const map = screen.getByRole("img", { name: "Carte du secteur de Terrain" });
    expect(map.getAttribute("src")).toContain(",11.64/400x300.webp?access_token=");
    expect(map.getAttribute("srcset")).toContain(",11.64/400x300@2x.webp?access_token=");
    expect(map.getAttribute("src")).toContain("/api.mapbox.com/");
  });

  it("conserve une photo additionnelle du bien lorsque le satellite Mapbox échoue", async () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

    const additionalPhoto = "https://images.example.test/photo-annonce.jpg";
    render(<SaleVisual sale={saleWithMedia(additionalPhoto)} title="Maison à Bordeaux" />);

    fireEvent.error(
      screen.getByRole("img", {
        name: "Vue aérienne de Maison à Bordeaux",
      }),
    );

    const photo = await screen.findByRole("img", { name: "Maison à Bordeaux" });
    expect(photo.getAttribute("src")).toBe(additionalPhoto);

    fireEvent.load(photo);
    expect(await screen.findByText("Photo du bien")).toBeTruthy();
  });

  it("récupère une erreur d'image survenue avant l'hydratation", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
    vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(0);

    render(
      <SaleVisual
        sale={{
          ...saleWithMedia("https://images.example.test/photo-expiree.jpg"),
          latitude: null,
          longitude: null,
        }}
        title="Terrain à Guillaumes"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Aucun visuel fiable")).toBeTruthy();
    });
    expect(screen.queryByRole("img")).toBeNull();
  });
});

function saleWithMedia(url: string): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    id: `sale-${url}`,
    media: [{ type: "image", url }],
  } as AuctionSale;
}
