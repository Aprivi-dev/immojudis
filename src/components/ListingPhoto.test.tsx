// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageConfigContext } from "next/dist/shared/lib/image-config-context.shared-runtime";
import { imageConfigDefault } from "next/dist/shared/lib/image-config";
import { listingPhotoRemotePatterns } from "@/lib/listing-photo-source";
import { ListingPhoto } from "./ListingPhoto";

afterEach(cleanup);

it("replaces a failed external photo with an accessible placeholder and retries a new source", () => {
  const view = render(<ListingPhoto src="https://example.test/first.jpg" alt="Salon" />);
  fireEvent.error(screen.getByRole("img", { name: "Salon" }));
  expect(screen.getByRole("img", { name: "Salon : indisponible" })).toBeTruthy();
  expect(screen.getByText("Photo indisponible")).toBeTruthy();
  view.rerender(<ListingPhoto src="https://example.test/second.jpg" alt="Cuisine" />);
  expect(screen.getByRole("img", { name: "Cuisine" }).getAttribute("src")).toBe(
    "https://example.test/second.jpg",
  );
  expect(screen.queryByText("Photo indisponible")).toBeNull();
});

it("serves responsive variants and falls back to the source if optimization fails", async () => {
  const source = "https://avoventes.fr/public/uploads/cabinet/286/images/property.png";
  const onOriginalError = vi.fn();
  render(
    <ImageConfigContext.Provider
      value={{ ...imageConfigDefault, remotePatterns: listingPhotoRemotePatterns }}
    >
      <ListingPhoto
        src={source}
        alt="Salon optimisé"
        fetchPriority="high"
        onOriginalError={onOriginalError}
      />
    </ImageConfigContext.Provider>,
  );
  const optimized = await screen.findByRole("img", { name: "Salon optimisé" });
  expect(optimized.getAttribute("src")).toContain("/_next/image?");
  expect(optimized.getAttribute("srcset")).toContain("640w");
  expect(optimized.getAttribute("loading")).toBe("eager");
  fireEvent.error(optimized);
  expect(screen.getByRole("img", { name: "Salon optimisé" }).getAttribute("src")).toBe(source);
  expect(onOriginalError).not.toHaveBeenCalled();
  fireEvent.error(screen.getByRole("img", { name: "Salon optimisé" }));
  expect(onOriginalError).toHaveBeenCalledOnce();
  expect(screen.getByRole("img", { name: "Salon optimisé : indisponible" })).toBeTruthy();
});

const MIRROR = {
  src: "https://ci.supabase.co/storage/v1/object/public/sale-photos/s/a-1600.webp",
  srcSet:
    "https://ci.supabase.co/storage/v1/object/public/sale-photos/s/a-640.webp 640w, " +
    "https://ci.supabase.co/storage/v1/object/public/sale-photos/s/a-1600.webp 1600w",
};

it("sert d'abord notre copie, directement, sans passer par l'optimiseur", () => {
  const source = "https://avoventes.fr/public/uploads/cabinet/286/images/property.png";
  render(
    <ImageConfigContext.Provider
      value={{ ...imageConfigDefault, remotePatterns: listingPhotoRemotePatterns }}
    >
      <ListingPhoto src={source} mirror={MIRROR} alt="Salon" sizes="100vw" />
    </ImageConfigContext.Provider>,
  );

  const image = screen.getByRole("img", { name: "Salon" });
  expect(image.getAttribute("src")).toBe(MIRROR.src);
  expect(image.getAttribute("srcset")).toBe(MIRROR.srcSet);
  expect(image.getAttribute("sizes")).toBe("100vw");
  expect(image.getAttribute("src")).not.toContain("/_next/image");
});

it("si la copie échoue, retombe sur la source exactement comme avant (optimiseur puis direct)", async () => {
  const source = "https://avoventes.fr/public/uploads/cabinet/286/images/property.png";
  const onOriginalError = vi.fn();
  const onError = vi.fn();
  render(
    <ImageConfigContext.Provider
      value={{ ...imageConfigDefault, remotePatterns: listingPhotoRemotePatterns }}
    >
      <ListingPhoto
        src={source}
        mirror={MIRROR}
        alt="Salon"
        onError={onError}
        onOriginalError={onOriginalError}
      />
    </ImageConfigContext.Provider>,
  );

  fireEvent.error(screen.getByRole("img", { name: "Salon" }));
  const optimized = await screen.findByRole("img", { name: "Salon" });
  expect(optimized.getAttribute("src")).toContain("/_next/image?");
  expect(optimized.getAttribute("srcset")).toContain("640w");
  expect(onOriginalError).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();

  fireEvent.error(optimized);
  expect(screen.getByRole("img", { name: "Salon" }).getAttribute("src")).toBe(source);
  fireEvent.error(screen.getByRole("img", { name: "Salon" }));
  expect(onOriginalError).toHaveBeenCalledOnce();
  expect(screen.getByText("Photo indisponible")).toBeTruthy();
});

it("hors des trois hôtes de l'optimiseur, la source est servie directement après la copie", () => {
  const source = "https://www.licitor.com/photos/a.jpg";
  render(<ListingPhoto src={source} mirror={MIRROR} alt="Maison" />);

  fireEvent.error(screen.getByRole("img", { name: "Maison" }));

  const image = screen.getByRole("img", { name: "Maison" });
  expect(image.getAttribute("src")).toBe(source);
  expect(image.getAttribute("srcset")).toBeNull();
});

it("récupère une copie en erreur avant l'hydratation", () => {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
  const source = "https://www.licitor.com/photos/a.jpg";
  const onOriginalError = vi.fn();
  try {
    render(
      <ListingPhoto src={source} mirror={MIRROR} alt="Maison" onOriginalError={onOriginalError} />,
    );
    // La copie est tombée, puis la source (déjà « complete » sans pixels) : placeholder.
    expect(onOriginalError).toHaveBeenCalledOnce();
    expect(screen.getByText("Photo indisponible")).toBeTruthy();
  } finally {
    vi.restoreAllMocks();
  }
});

it("sans copie, le rendu est celui d'avant", () => {
  const source = "https://www.licitor.com/photos/a.jpg";
  render(<ListingPhoto src={source} mirror={null} alt="Maison" />);
  expect(screen.getByRole("img", { name: "Maison" }).getAttribute("src")).toBe(source);
});

it("une nouvelle copie pour la même source repart de la copie", () => {
  const source = "https://www.licitor.com/photos/a.jpg";
  const view = render(<ListingPhoto src={source} mirror={MIRROR} alt="Maison" />);
  fireEvent.error(screen.getByRole("img", { name: "Maison" }));
  expect(screen.getByRole("img", { name: "Maison" }).getAttribute("src")).toBe(source);

  view.rerender(<ListingPhoto src={source} mirror={{ src: `${MIRROR.src}?v=2` }} alt="Maison" />);
  expect(screen.getByRole("img", { name: "Maison" }).getAttribute("src")).toBe(`${MIRROR.src}?v=2`);
});
