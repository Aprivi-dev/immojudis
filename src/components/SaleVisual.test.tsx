// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const label = await screen.findByText("Vue aérienne Mapbox");
    expect(label).toBeTruthy();
    // En haut à gauche : le logo Mapbox, incrusté dans l'image, est en bas à gauche.
    expect(label.className).toContain("top-2");
    expect(label.className).toContain("left-2");
    expect(label.className).not.toContain("bottom-2");
  });

  it.each([
    ["une précision de commune", { location_precision: "municipality" }],
    ["une précision de rue", { location_precision: "street" }],
    ["une précision inconnue", { location_precision: null }],
    ["une précision non chargée", { location_precision: undefined }],
    ["une adresse sans numéro", { address: "rue de l'Exemple" }],
    ["un point douteux", { quality_flags: ["unverified_source_coordinates"] }],
    ["une copie probable", { quality_flags: ["probable_duplicate"] }],
    ["un point hors de France", { latitude: 0, longitude: 0 }],
  ])("n'affiche pas le satellite pour %s", (_name, override) => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

    render(
      <SaleVisual
        sale={
          {
            ...saleWithMedia("https://images.example.test/p.jpg"),
            media: [],
            ...override,
          } as AuctionSale
        }
        title="Maison"
        sectorMap={false}
        placeLabel="Nice"
      />,
    );

    expect(screen.queryByRole("img", { name: "Vue aérienne de Maison" })).toBeNull();
    expect(screen.getByText("Aucun visuel fiable")).toBeTruthy();
  });

  it("garde le satellite pour une parcelle sans signalement douteux", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

    render(
      <SaleVisual
        sale={
          {
            ...saleWithMedia("https://images.example.test/p.jpg"),
            location_precision: "parcel",
            quality_flags: ["some_text_quality_flag"],
          } as AuctionSale
        }
        title="Maison"
      />,
    );

    expect(screen.getByRole("img", { name: "Vue aérienne de Maison" })).toBeTruthy();
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
    expect(satellite.getAttribute("src")).toContain(",16.64/400x300.webp?access_token=");
    expect(satellite.getAttribute("src")).not.toContain("@2x");
    const srcSet = satellite.getAttribute("srcset") ?? "";
    const [oneX, twoX] = srcSet.split(", ");
    expect(oneX).toBe(`${satellite.getAttribute("src")} 1x`);
    expect(twoX).toContain(",16.64/400x300@2x.webp?access_token=");
    expect(twoX).toMatch(/ 2x$/);
    // WebP natif Mapbox aussi pour le satellite (228 Ko en JPEG contre 180 Ko en WebP, mesuré).
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

  it("liste des ventes : sans adresse, une case neutre avec la ville plutôt que la carte du secteur", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");

    render(
      <SaleVisual
        sale={{ ...EXAMPLE_SALE, media: [], address: null } as AuctionSale}
        title="Garage à Lyon"
        thumbnail
        sectorMap={false}
        placeLabel="Lyon"
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Aucun visuel fiable")).toBeTruthy();
    expect(screen.getByText("Lyon")).toBeTruthy();
  });

  it("liste des ventes : avec une adresse, la vue satellite reste le visuel sans photo", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

    render(
      <SaleVisual
        sale={{ ...EXAMPLE_SALE, media: [] } as AuctionSale}
        title="Appartement à Bordeaux"
        thumbnail
        sectorMap={false}
        placeLabel="Bordeaux"
      />,
    );

    expect(
      screen
        .getByRole("img", { name: "Vue aérienne de Appartement à Bordeaux" })
        .getAttribute("src"),
    ).toContain("/mapbox/satellite-v9/static/");
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

  describe("visuel prioritaire affiché sans attendre le JavaScript", () => {
    it("le HTML serveur d'un visuel eager contient l'image visible, sans squelette", () => {
      vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");

      const html = renderToString(
        <SaleVisual
          sale={saleWithMedia("https://images.example.test/p.jpg")}
          title="Maison"
          eager
          thumbnail
        />,
      );

      expect(html).toContain("<img");
      expect(html).toContain("/mapbox/satellite-v9/static/");
      expect(html).toContain('fetchPriority="high"');
      expect(html).not.toContain("opacity-0");
      expect(html).not.toContain("animate-pulse");
      expect(html).not.toContain('aria-busy="true"');
    });

    it("le HTML serveur d'une photo de source eager reste masqué (logo, bannière, image cassée)", () => {
      const html = renderToString(
        <SaleVisual
          sale={{ ...saleWithMedia("https://www.licitor.com/photos/a.jpg"), latitude: null }}
          title="Maison"
          eager
        />,
      );

      expect(html).toContain("<img");
      expect(html).toContain("opacity-0");
      expect(html).not.toContain("opacity-100");
      expect(html).toContain("animate-pulse");
      expect(html).toContain('aria-busy="true"');
    });

    it("le HTML serveur d'une carte du secteur Mapbox eager est visible", () => {
      vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");

      const html = renderToString(
        <SaleVisual
          sale={{ ...saleWithMedia("https://www.licitor.com/photos/a.jpg"), address: null }}
          title="Maison"
          eager
        />,
      );

      expect(html).toContain("/mapbox/streets-v12/static/");
      expect(html).not.toContain("opacity-0");
    });

    it("garde le squelette et l'image masquée d'un visuel différé jusqu'au chargement", () => {
      vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

      const { container } = render(
        <SaleVisual sale={saleWithMedia("https://images.example.test/p.jpg")} title="Maison" />,
      );

      const image = screen.getByRole("img", { name: "Vue aérienne de Maison" });
      expect(image.className).toContain("opacity-0");
      expect(container.querySelector(".animate-pulse")).not.toBeNull();
      expect(container.firstElementChild?.getAttribute("aria-busy")).toBe("true");

      fireEvent.load(image);
      expect(image.className).toContain("opacity-100");
      expect(container.querySelector(".animate-pulse")).toBeNull();
    });

    it("un visuel eager est visible avant tout onLoad et ne dépend pas de l'hydratation", () => {
      vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

      const { container } = render(
        <SaleVisual
          sale={saleWithMedia("https://images.example.test/p.jpg")}
          title="Maison"
          eager
        />,
      );

      const image = screen.getByRole("img", { name: "Vue aérienne de Maison" });
      expect(image.className).toContain("opacity-100");
      expect(image.className).not.toContain("opacity-0");
      expect(container.querySelector(".animate-pulse")).toBeNull();
      expect(container.firstElementChild?.getAttribute("aria-busy")).toBe("false");
      expect(image.getAttribute("loading")).toBe("eager");
      expect(image.getAttribute("fetchpriority")).toBe("high");
    });

    it("passe au candidat suivant sur une erreur, même pour un visuel eager", async () => {
      vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test-token");
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

      render(
        <SaleVisual
          sale={saleWithMedia("https://images.example.test/photo-annonce.jpg")}
          title="Maison"
          eager
        />,
      );
      fireEvent.error(screen.getByRole("img", { name: "Vue aérienne de Maison" }));

      // Le candidat suivant est une photo de la source : masquée tant qu'elle n'est pas chargée.
      const photo = await screen.findByRole("img", { name: "Maison" });
      expect(photo.getAttribute("src")).toBe("https://images.example.test/photo-annonce.jpg");
      expect(photo.className).toContain("opacity-0");
      fireEvent.load(photo);
      expect(photo.className).toContain("opacity-100");

      fireEvent.error(photo);
      expect(await screen.findByText("Aucun visuel fiable")).toBeTruthy();
      expect(screen.queryByRole("img")).toBeNull();
    });

    it("écarte une photo rejetée par le contrôle de taille, même eager", async () => {
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(120);
      vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(80);

      render(
        <SaleVisual
          sale={{ ...saleWithMedia("https://images.example.test/petite.jpg"), latitude: null }}
          title="Maison"
          eager
        />,
      );
      fireEvent.load(screen.getByRole("img", { name: "Maison" }));

      expect(await screen.findByText("Aucun visuel fiable")).toBeTruthy();
    });

    it("récupère aussi une erreur survenue avant l'hydratation d'un visuel eager", async () => {
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
      vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(0);

      render(
        <SaleVisual
          sale={{ ...saleWithMedia("https://images.example.test/expiree.jpg"), latitude: null }}
          title="Terrain"
          eager
        />,
      );

      await waitFor(() => expect(screen.getByText("Aucun visuel fiable")).toBeTruthy());
    });
  });

  describe("source de la photo", () => {
    const noMap = (url: string) => ({ ...saleWithMedia(url), latitude: null, longitude: null });

    it("remplace « Photo du bien » par « Photo · [source] » quand l'hôte est connu", async () => {
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

      render(<SaleVisual sale={noMap("https://www.licitor.com/photos/a.jpg")} title="Maison" />);
      fireEvent.load(screen.getByRole("img", { name: "Maison" }));

      expect(await screen.findByText("Photo · Licitor")).toBeTruthy();
      expect(screen.queryByText("Photo du bien")).toBeNull();
    });

    it("garde « Photo du bien » quand la source est inconnue", async () => {
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);

      render(<SaleVisual sale={noMap("https://cdn.exemple.test/a.jpg")} title="Maison" />);
      fireEvent.load(screen.getByRole("img", { name: "Maison" }));

      expect(await screen.findByText("Photo du bien")).toBeTruthy();
    });
  });

  describe("copie hébergée de la photo", () => {
    const ORIGINAL = "https://www.licitor.com/photos/a.jpg";
    const MIRROR_URL = "https://ci.supabase.co/storage/v1/object/public/sale-photos/s/a-640.webp";

    function mirrored(): AuctionSale {
      return {
        ...saleWithMedia(ORIGINAL),
        latitude: null,
        longitude: null,
        media: [
          {
            type: "image",
            url: ORIGINAL,
            mirror: {
              path640: "s/a-640.webp",
              path1600: "s/a-1600.webp",
              width: 1600,
              height: 1200,
            },
          },
        ],
      } as AuctionSale;
    }

    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
      vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    });

    it("affiche d'abord la copie, avec la source de l'URL d'origine", async () => {
      render(<SaleVisual sale={mirrored()} title="Maison" />);

      const photo = screen.getByRole("img", { name: "Maison" });
      expect(photo.getAttribute("src")).toBe(MIRROR_URL);
      fireEvent.load(photo);
      expect(await screen.findByText("Photo · Licitor")).toBeTruthy();
    });

    it("si la copie échoue, retombe sur la photo de la source, puis sur le visuel suivant", async () => {
      render(<SaleVisual sale={mirrored()} title="Maison" />);

      fireEvent.error(screen.getByRole("img", { name: "Maison" }));
      const source = await screen.findByRole("img", { name: "Maison" });
      expect(source.getAttribute("src")).toBe(ORIGINAL);

      fireEvent.error(source);
      expect(await screen.findByText("Aucun visuel fiable")).toBeTruthy();
    });

    it("le HTML serveur d'une copie eager est visible, celui de la photo de source ne l'est pas", () => {
      const withMirror = renderToString(<SaleVisual sale={mirrored()} title="Maison" eager />);
      expect(withMirror).toContain(MIRROR_URL);
      expect(withMirror).not.toContain("opacity-0");
      expect(withMirror).not.toContain("animate-pulse");

      const withoutMirror = renderToString(
        <SaleVisual
          sale={{ ...mirrored(), media: [{ type: "image", url: ORIGINAL }] }}
          title="Maison"
          eager
        />,
      );
      expect(withoutMirror).toContain(ORIGINAL);
      expect(withoutMirror).toContain("opacity-0");
    });

    it("copie eager en erreur : la photo de la source ne paraît qu'une fois chargée", async () => {
      render(<SaleVisual sale={mirrored()} title="Maison" eager />);
      const copy = screen.getByRole("img", { name: "Maison" });
      expect(copy.className).toContain("opacity-100");

      fireEvent.error(copy);
      const source = await screen.findByRole("img", { name: "Maison" });
      expect(source.getAttribute("src")).toBe(ORIGINAL);
      expect(source.className).toContain("opacity-0");
      fireEvent.load(source);
      expect(source.className).toContain("opacity-100");
    });

    it("la liste des candidats change après l'échec de la copie : la source reste affichée", async () => {
      const { rerender } = render(<SaleVisual sale={mirrored()} title="Maison" />);

      fireEvent.error(screen.getByRole("img", { name: "Maison" }));
      const source = await screen.findByRole("img", { name: "Maison" });
      expect(source.getAttribute("src")).toBe(ORIGINAL);

      // La copie disparaît d'un rafraîchissement : [copie, source] devient [source].
      rerender(
        <SaleVisual
          sale={{ ...mirrored(), media: [{ type: "image", url: ORIGINAL }] }}
          title="Maison"
        />,
      );

      const still = screen.getByRole("img", { name: "Maison" });
      expect(still.getAttribute("src")).toBe(ORIGINAL);
      expect(screen.queryByText("Aucun visuel fiable")).toBeNull();
      fireEvent.load(still);
      expect(await screen.findByText("Photo · Licitor")).toBeTruthy();
    });

    it("une copie qui apparaît après coup passe devant la source, sans perdre la photo", async () => {
      const unmirrored = { ...mirrored(), media: [{ type: "image" as const, url: ORIGINAL }] };
      const { rerender } = render(<SaleVisual sale={unmirrored} title="Maison" />);
      expect(screen.getByRole("img", { name: "Maison" }).getAttribute("src")).toBe(ORIGINAL);

      rerender(<SaleVisual sale={mirrored()} title="Maison" />);

      const copy = screen.getByRole("img", { name: "Maison" });
      expect(copy.getAttribute("src")).toBe(MIRROR_URL);
      fireEvent.error(copy);
      expect((await screen.findByRole("img", { name: "Maison" })).getAttribute("src")).toBe(
        ORIGINAL,
      );
    });

    it("ne soumet pas la copie 640 px au contrôle de taille de l'original", async () => {
      vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(640);
      vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(230);

      render(<SaleVisual sale={mirrored()} title="Maison" />);
      fireEvent.load(screen.getByRole("img", { name: "Maison" }));

      expect(await screen.findByText("Photo · Licitor")).toBeTruthy();
    });
  });
});

function saleWithMedia(url: string): AuctionSale {
  return {
    ...EXAMPLE_SALE,
    id: `sale-${url}`,
    location_precision: "address",
    quality_flags: [],
    media: [{ type: "image", url }],
  } as AuctionSale;
}
