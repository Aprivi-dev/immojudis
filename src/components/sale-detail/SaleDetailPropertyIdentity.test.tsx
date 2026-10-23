// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
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

// Avec des coordonnées, la fiche monte le bouton Street View, qui interroge via React Query.
function renderWithClient(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("fiche : vue aérienne 360° et photos", () => {
  const located = {
    latitude: 44.8378,
    longitude: -0.5792,
    address: "12 rue Sainte-Catherine",
    postal_code: "33000",
    quality_flags: [],
    location_precision: "address",
  } as Partial<AuctionSale>;
  const onePhoto = [{ type: "image", url: LICITOR_PHOTO }] as Partial<AuctionSale>["media"];

  const aerial = () => screen.queryByRole("img", { name: /Vue aérienne autour/ });
  const toggle = (name: "Photos" | "Vue 360°") => screen.getByRole("button", { name });

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "pk.test");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    window.history.replaceState(null, "", "/");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("avec deux photos ou plus, montre les photos d'abord et propose la vue 360° dans un sélecteur", () => {
    renderWithClient(<PropertyIdentity sale={sale(located)} />);

    expect(aerial()).toBeNull();
    expect(screen.getByRole("button", { name: "Ouvrir la galerie photos" })).toBeTruthy();
    const group = screen.getByRole("group", { name: "Visuel du bien" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Photos", "Vue 360°"]);
    expect(toggle("Photos").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("Vue 360°").getAttribute("aria-pressed")).toBe("false");
    // La carte et l'image Mapbox ne sont pas chargées tant que la vue 360° n'est pas demandée.
    expect(screen.queryByRole("button", { name: "Lancer la vue 360°" })).toBeNull();
  });

  it("le bouton « Vue 360° » met la vue aérienne en tête et les photos en vignettes, et le lance", () => {
    renderWithClient(<PropertyIdentity sale={sale(located)} />);

    fireEvent.click(toggle("Vue 360°"));

    expect(
      screen.getByRole("img", { name: /Vue aérienne autour de l’adresse 12 rue Sainte-Catherine/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ouvrir la galerie photos" })).toBeNull();
    expect(screen.getByText("Photos de l’annonce")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ouvrir la photo 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ouvrir la photo 2" })).toBeTruthy();
    expect(screen.getByTestId("photo-credit").textContent).toBe("Photos : via Licitor, Vench");
    expect(toggle("Vue 360°").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("Photos").getAttribute("aria-pressed")).toBe("false");
    // Sans IntersectionObserver (jsdom), la carte animée n'est pas chargée : l'image fixe reste.
    expect(
      screen.getByRole("button", { name: /Lancer la vue 360°|Chargement de la vue/ }),
    ).toBeTruthy();
  });

  it("le bouton « Photos » revient aux photos", () => {
    renderWithClient(<PropertyIdentity sale={sale(located)} />);
    fireEvent.click(toggle("Vue 360°"));

    fireEvent.click(toggle("Photos"));

    expect(aerial()).toBeNull();
    expect(screen.getByRole("button", { name: "Ouvrir la galerie photos" })).toBeTruthy();
    expect(toggle("Photos").getAttribute("aria-pressed")).toBe("true");
  });

  it("ne monte la vue aérienne qu'une fois choisie, puis la garde montée (masquée) au retour aux photos", () => {
    const { container } = renderWithClient(<PropertyIdentity sale={sale(located)} />);
    const hero = () => container.querySelector("[data-orbit-status]");

    // Jamais choisie : pas montée, donc rien n'est chargé (ni image ni carte Mapbox).
    expect(hero()).toBeNull();

    fireEvent.click(toggle("Vue 360°"));
    const mounted = hero();
    expect(mounted).not.toBeNull();
    expect(aerial()).toBeTruthy();

    // Retour aux photos : le même élément reste monté, masqué (pas de rechargement à la prochaine bascule).
    fireEvent.click(toggle("Photos"));
    expect(hero()).toBe(mounted);
    expect(aerial()).toBeNull();
    expect(mounted?.closest("[hidden]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Ouvrir la galerie photos" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Lancer la vue 360°/ })).toBeNull();

    fireEvent.click(toggle("Vue 360°"));
    expect(hero()).toBe(mounted);
    expect(aerial()).toBeTruthy();
    expect(mounted?.closest("[hidden]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Ouvrir la galerie photos" })).toBeNull();
  });

  it("avec une seule photo, la vue 360° passe devant et la photo reste accessible", () => {
    renderWithClient(<PropertyIdentity sale={sale({ ...located, media: onePhoto })} />);

    expect(aerial()).toBeTruthy();
    expect(toggle("Vue 360°").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Voir la photo" })).toBeTruthy();

    fireEvent.click(toggle("Photos"));

    expect(aerial()).toBeNull();
    expect(screen.getByRole("button", { name: "Ouvrir la galerie photos" })).toBeTruthy();
  });

  it("sans photo, montre la vue aérienne sans sélecteur", () => {
    renderWithClient(<PropertyIdentity sale={sale({ ...located, media: [] })} />);

    expect(aerial()).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Visuel du bien" })).toBeNull();
    expect(screen.queryByText("Photos de l’annonce")).toBeNull();
  });

  it.each([
    ["vue", 2, true],
    ["photos", 1, false],
  ] as const)(
    "?visuel=%s impose ce visuel (%i photo(s))",
    async (visuel, photoCount, aerialShown) => {
      window.history.replaceState(null, "", `/sales/x?visuel=${visuel}`);
      const media = [
        { type: "image", url: LICITOR_PHOTO },
        { type: "image", url: VENCH_PHOTO },
      ].slice(0, photoCount) as Partial<AuctionSale>["media"];

      renderWithClient(<PropertyIdentity sale={sale({ ...located, media })} />);

      await waitFor(() => expect(Boolean(aerial())).toBe(aerialShown));
      expect(toggle("Vue 360°").getAttribute("aria-pressed")).toBe(String(aerialShown));
    },
  );

  it("ignore un ?visuel= inconnu", async () => {
    window.history.replaceState(null, "", "/sales/x?visuel=carte");

    renderWithClient(<PropertyIdentity sale={sale(located)} />);

    await Promise.resolve();
    expect(aerial()).toBeNull();
    expect(toggle("Photos").getAttribute("aria-pressed")).toBe("true");
  });

  it("?visuel=vue ne force pas la vue 360° quand la position n'est pas sûre", async () => {
    window.history.replaceState(null, "", "/sales/x?visuel=vue");

    renderWithClient(
      <PropertyIdentity sale={sale({ ...located, location_precision: "municipality" })} />,
    );

    await Promise.resolve();
    expect(aerial()).toBeNull();
    expect(screen.queryByRole("group", { name: "Visuel du bien" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ouvrir la galerie photos" })).toBeTruthy();
  });

  it("ouvre la galerie depuis le lien « Voir les photos »", async () => {
    renderWithClient(<PropertyIdentity sale={sale(located)} />);
    fireEvent.click(toggle("Vue 360°"));

    fireEvent.click(screen.getByRole("button", { name: "Voir les 2 photos" }));

    const dialog = await screen.findByRole("dialog", { name: "Galerie photos" });
    expect(within(dialog).getByTestId("photo-credit").textContent).toBe("Photo : via Licitor");
  });

  it("garde la photo en tête quand l'adresse n'a pas de numéro, sans sélecteur", () => {
    renderWithClient(
      <PropertyIdentity sale={sale({ ...located, address: "rue Sainte-Catherine" })} />,
    );

    expect(aerial()).toBeNull();
    expect(screen.queryByRole("group", { name: "Visuel du bien" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ouvrir la galerie photos" })).toBeTruthy();
  });

  it("garde la photo en tête sans jeton Mapbox", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN", "");
    renderWithClient(<PropertyIdentity sale={sale(located)} />);

    expect(aerial()).toBeNull();
    expect(screen.queryByRole("group", { name: "Visuel du bien" })).toBeNull();
  });

  it.each([null, undefined, "street", "municipality"])(
    "garde la photo en tête quand la précision du point est %s",
    (location_precision) => {
      renderWithClient(<PropertyIdentity sale={sale({ ...located, location_precision })} />);

      expect(aerial()).toBeNull();
    },
  );

  it("n'affiche pas la vue aérienne d'un parking", () => {
    renderWithClient(<PropertyIdentity sale={sale({ ...located, property_type: "parking" })} />);

    expect(aerial()).toBeNull();
  });

  it("n'affiche pas la vue aérienne d'un doublon probable, même demandée", async () => {
    window.history.replaceState(null, "", "/sales/x?visuel=vue");

    renderWithClient(
      <PropertyIdentity
        sale={sale({ ...located, quality_flags: ["multi_lot_sale", "probable_duplicate"] })}
      />,
    );

    await Promise.resolve();
    expect(aerial()).toBeNull();
    expect(screen.queryByRole("group", { name: "Visuel du bien" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ouvrir la galerie photos" })).toBeTruthy();
  });

  it("crédite chaque source des vignettes, sans doublon", () => {
    renderWithClient(<PropertyIdentity sale={sale(located)} />);
    fireEvent.click(toggle("Vue 360°"));

    // Photo 1 : Licitor (copie hébergée), photo 2 : Vench.
    expect(screen.getByTestId("photo-credit").textContent).toBe("Photos : via Licitor, Vench");
  });

  it("écrit « Voir la photo » au singulier", () => {
    renderWithClient(<PropertyIdentity sale={sale({ ...located, media: onePhoto })} />);

    expect(screen.getByRole("button", { name: "Voir la photo" })).toBeTruthy();
    expect(screen.queryByText(/Voir les 1 photo/)).toBeNull();
  });

  it("masque le bloc des photos quand toutes les vignettes échouent", () => {
    renderWithClient(
      <PropertyIdentity
        sale={sale({
          ...located,
          media: [
            { type: "image", url: "https://www.licitor.com/photos/a.jpg" },
            { type: "image", url: "https://www.licitor.com/photos/b.jpg" },
          ],
        } as Partial<AuctionSale>)}
      />,
    );
    fireEvent.click(toggle("Vue 360°"));
    expect(screen.getByText("Photos de l’annonce")).toBeTruthy();

    const thumbnails = screen
      .getAllByRole("img", { name: /^Photo \d de/ })
      .filter((image) => image.tagName === "IMG");
    expect(thumbnails).toHaveLength(2);
    for (const thumbnail of thumbnails) fireEvent.error(thumbnail);

    expect(screen.queryByText("Photos de l’annonce")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Voir/ })).toBeNull();
    expect(screen.queryByTestId("photo-credit")).toBeNull();
  });

  it("ne crédite plus qu'une vignette quand l'autre a échoué", () => {
    renderWithClient(
      <PropertyIdentity
        sale={sale({
          ...located,
          media: [
            { type: "image", url: "https://www.licitor.com/photos/a.jpg" },
            { type: "image", url: "https://d1x9.cloudfront.net/p/b.jpg" },
          ],
        } as Partial<AuctionSale>)}
      />,
    );
    fireEvent.click(toggle("Vue 360°"));
    expect(screen.getByTestId("photo-credit").textContent).toBe(
      "Photos : via Licitor, source de l'annonce",
    );

    const second = screen
      .getAllByRole("img", { name: /^Photo 2 de/ })
      .find((image) => image.tagName === "IMG")!;
    fireEvent.error(second);

    expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : via Licitor");
  });

  it("en démonstration publique, la vue aérienne n'est qu'une image fixe sans bouton de lancement", () => {
    renderWithClient(<PropertyIdentity sale={sale(located)} publicDemo />);
    fireEvent.click(toggle("Vue 360°"));

    expect(aerial()).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Lancer la vue 360°/ })).toBeNull();
  });
});
