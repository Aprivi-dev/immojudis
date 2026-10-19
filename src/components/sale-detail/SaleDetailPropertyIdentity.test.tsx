// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { PropertyIdentity } from "./SaleDetailPropertyIdentity";

const BASE = "https://ci.supabase.co/storage/v1/object/public/sale-photos/";
const LICITOR_PHOTO = "https://www.licitor.com/photos/maison-1.jpg";
const VENCH_PHOTO = "https://www.vench.fr/vignettes/v2.jpg";

function sale(overrides: Partial<AuctionSale> = {}): AuctionSale {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    city: "Bordeaux",
    property_type: "house",
    source_name: "licitor",
    source_url: "https://www.licitor.com/annonce/1/2/3/vente.html",
    source_urls: ["https://www.licitor.com/annonce/1/2/3/vente.html"],
    media: [
      {
        type: "image",
        url: LICITOR_PHOTO,
        mirror: {
          path640: "s/a-640.webp",
          path1600: "s/a-1600.webp",
          width: 1600,
          height: 1200,
        },
      },
      { type: "image", url: VENCH_PHOTO },
    ],
    ...overrides,
  } as unknown as AuctionSale;
}

describe("fiche : photo principale", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("crédite la photo d'après son URL d'origine, avec un lien vers l'annonce de la source", () => {
    render(<PropertyIdentity sale={sale()} />);

    const credit = screen.getByTestId("photo-credit");
    expect(credit.textContent).toBe("Photo : via Licitor");
    const link = within(credit).getByRole("link", { name: "Licitor" });
    expect(link.getAttribute("href")).toBe("https://www.licitor.com/annonce/1/2/3/vente.html");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("nofollow noopener noreferrer");
  });

  it("affiche la copie en srcset 640w / 1600w au lieu de la photo de la source", () => {
    render(<PropertyIdentity sale={sale()} />);

    const main = screen
      .getAllByRole("img", { name: /Photo principale de/ })
      .find((image) => image.getAttribute("src")?.startsWith(BASE));
    expect(main?.getAttribute("src")).toBe(`${BASE}s/a-1600.webp`);
    expect(main?.getAttribute("srcset")).toBe(
      `${BASE}s/a-640.webp 640w, ${BASE}s/a-1600.webp 1600w`,
    );
    expect(screen.getByTestId("photo-credit").textContent).not.toContain("supabase");
  });

  it("sans copie, la page est celle d'avant et le crédit reste celui de la source", () => {
    render(
      <PropertyIdentity
        sale={sale({ media: [{ type: "image", url: LICITOR_PHOTO }] } as Partial<AuctionSale>)}
      />,
    );

    const images = screen.getAllByRole("img", { name: /Photo principale de/ });
    expect(images.every((image) => image.getAttribute("src") === LICITOR_PHOTO)).toBe(true);
    expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : via Licitor");
  });

  it("ne lie pas vers une autre source que celle de la photo", () => {
    render(
      <PropertyIdentity
        sale={sale({ media: [{ type: "image", url: VENCH_PHOTO }] } as Partial<AuctionSale>)}
      />,
    );

    expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : via Vench");
    expect(within(screen.getByTestId("photo-credit")).queryByRole("link")).toBeNull();
  });

  it("hôte inconnu : « source de l'annonce », sans hôte brut ni lien", () => {
    render(
      <PropertyIdentity
        sale={sale({
          media: [{ type: "image", url: "https://d1x9.cloudfront.net/p/a.jpg" }],
        } as Partial<AuctionSale>)}
      />,
    );

    const credit = screen.getByTestId("photo-credit");
    expect(credit.textContent).toBe("Photo : source de l'annonce");
    expect(within(credit).queryByRole("link")).toBeNull();
  });

  it("ne crédite rien sans photo", () => {
    render(<PropertyIdentity sale={sale({ media: [] })} />);
    expect(screen.queryByTestId("photo-credit")).toBeNull();
  });

  it("la galerie plein écran crédite la photo ouverte", async () => {
    render(<PropertyIdentity sale={sale()} />);

    fireEvent.click(screen.getByRole("button", { name: "Ouvrir la galerie photos" }));

    const dialog = await screen.findByRole("dialog", { name: "Galerie photos" });
    expect(within(dialog).getByTestId("photo-credit").textContent).toBe("Photo : via Licitor");
  });
});
