// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PhotoCarouselDialog } from "./PhotoCarouselDialog";

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

const images = [
  { url: "https://example.test/1.jpg", alt: "Salon" },
  { url: "https://example.test/2.jpg", alt: "Cuisine" },
];

describe("gallery keyboard and touch", () => {
  it("wraps focus in both directions and restores the opener on unmount", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const view = render(
      <PhotoCarouselDialog images={images} initialIndex={0} onClose={() => {}} />,
    );
    const first = screen.getByRole("button", { name: "Fermer la galerie" });
    const last = screen.getByRole("button", { name: "Afficher la photo 2" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("changes photo on horizontal swipes but ignores vertical and short gestures", () => {
    render(<PhotoCarouselDialog images={images} initialIndex={0} onClose={() => {}} />);
    const swipe = (x: number, y: number) => {
      const image = screen.getByRole("img");
      fireEvent.touchStart(image, { changedTouches: [{ clientX: 200, clientY: 300 }] });
      fireEvent.touchEnd(image, { changedTouches: [{ clientX: x, clientY: y }] });
    };
    swipe(180, 305);
    expect(screen.getByRole("img").getAttribute("alt")).toBe("Salon");
    swipe(180, 450);
    expect(screen.getByRole("img").getAttribute("alt")).toBe("Salon");
    swipe(80, 305);
    expect(screen.getByRole("img").getAttribute("alt")).toBe("Cuisine");
    swipe(320, 305);
    expect(screen.getByRole("img").getAttribute("alt")).toBe("Salon");
  });
});

describe("copies et crédit des photos", () => {
  const mirror = {
    path640: "s/a-640.webp",
    path1600: "s/a-1600.webp",
    width: 1600,
    height: 1200,
  };
  const BASE = "https://ci.supabase.co/storage/v1/object/public/sale-photos/";

  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co"));
  afterEach(() => vi.unstubAllEnvs());

  it("affiche la grande copie (srcset 640w/1600w) et la petite en vignette", () => {
    render(
      <PhotoCarouselDialog
        images={[
          { url: "https://www.licitor.com/photos/a.jpg", alt: "Façade", mirror },
          { url: "https://www.licitor.com/photos/b.jpg", alt: "Salon" },
        ]}
        initialIndex={0}
        onClose={() => {}}
      />,
    );

    const main = screen.getByRole("img", { name: "Façade" });
    expect(main.getAttribute("src")).toBe(`${BASE}s/a-1600.webp`);
    expect(main.getAttribute("srcset")).toBe(
      `${BASE}s/a-640.webp 640w, ${BASE}s/a-1600.webp 1600w`,
    );
    const thumbnail = screen
      .getByRole("button", { name: "Afficher la photo 1" })
      .querySelector("img");
    expect(thumbnail?.getAttribute("src")).toBe(`${BASE}s/a-640.webp`);
  });

  it("retombe sur la photo de la source quand la copie échoue", () => {
    render(
      <PhotoCarouselDialog
        images={[{ url: "https://www.licitor.com/photos/a.jpg", alt: "Façade", mirror }]}
        initialIndex={0}
        onClose={() => {}}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Façade" }));

    const main = screen.getByRole("img", { name: "Façade" });
    expect(main.getAttribute("src")).toBe("https://www.licitor.com/photos/a.jpg");
    expect(main.getAttribute("srcset")).toBeNull();
  });

  it("crédite la photo affichée, avec un lien vers l'annonce d'origine", () => {
    render(
      <PhotoCarouselDialog
        images={[
          {
            url: "https://www.licitor.com/photos/a.jpg",
            alt: "Façade",
            credit: { label: "Licitor", href: "https://www.licitor.com/annonce/1.html" },
          },
          {
            url: "https://www.vench.fr/vignettes/v1.jpg",
            alt: "Salon",
            credit: { label: "Vench", href: null },
          },
        ]}
        initialIndex={0}
        onClose={() => {}}
      />,
    );

    const link = screen.getByRole("link", { name: "Licitor" });
    expect(link.getAttribute("rel")).toBe("nofollow noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");

    fireEvent.click(screen.getByRole("button", { name: "Photo suivante" }));
    expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : via Vench");
    expect(screen.queryByRole("link", { name: "Licitor" })).toBeNull();
  });

  it("source inconnue : « Photo : source de l'annonce », sans lien", () => {
    render(
      <PhotoCarouselDialog
        images={[
          {
            url: "https://d1x9.cloudfront.net/p/a.jpg",
            alt: "Façade",
            credit: { label: null, href: null },
          },
        ]}
        initialIndex={0}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId("photo-credit").textContent).toBe("Photo : source de l'annonce");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
