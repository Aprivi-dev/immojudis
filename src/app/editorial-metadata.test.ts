import { describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";
import { COMPANY_DESCRIPTION } from "@/lib/company-description";

// Only the `metadata` export matters here: the heavy server-side loaders of the pages are
// replaced so that importing a page does not need a database.
vi.mock("@/lib/public-catalogue.server", () => ({ loadInitialCatalogue: vi.fn() }));
vi.mock("@/lib/public-tribunal-activity.server", () => ({ loadPublicTribunalActivity: vi.fn() }));
vi.mock("@/lib/legal-documents", () => ({ publicLegalPublisher: vi.fn() }));

const TITLE_SUFFIX = " - Immojudis"; // `title.template` of app/layout.tsx
const MAX_TITLE_LENGTH = 60;

function titleText(metadata: Metadata): { text: string; absolute: boolean } {
  const { title } = metadata;
  if (typeof title === "string") return { text: title, absolute: false };
  if (title && typeof title === "object" && "absolute" in title && title.absolute) {
    return { text: title.absolute, absolute: true };
  }
  throw new Error("titre attendu");
}

describe("titles with the site suffix fit in 60 characters", () => {
  it.each([
    // `/sales` calcule ses métadonnées d'après l'adresse (voir `generateMetadata`) : ici la première
    // page, sans paramètre. Les pages 2 et suivantes sont contrôlées dans `sales/page.test.tsx`.
    [
      "/sales",
      async () => ({
        metadata: await (
          await import("./sales/page")
        ).generateMetadata({
          searchParams: Promise.resolve({}),
        }),
      }),
    ],
    ["/comment-ca-marche", () => import("./comment-ca-marche/page")],
    ["/annonce-exemple", () => import("./annonce-exemple/page")],
  ])(
    "%s",
    async (_path, importPage) => {
      const { text, absolute } = titleText((await importPage()).metadata as Metadata);
      expect(absolute).toBe(false);
      expect(text.length + TITLE_SUFFIX.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    },
    // Le premier import d'une page charge tout son graphe : large marge sur une machine chargée.
    30_000,
  );
});

describe("home page", () => {
  it.each([true, false])(
    "has its own title and description (notaries and State: %s), with share data",
    async (pilots) => {
      vi.stubEnv("NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED", pilots ? "true" : "false");
      const { generateMetadata } = await import("./page");
      const metadata = generateMetadata();
      const { text, absolute } = titleText(metadata);
      expect(absolute).toBe(true);
      expect(text).toBe("Ventes immobilières aux enchères judiciaires - Immojudis");
      expect(text.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
      const description = String(metadata.description);
      expect(description.length).toBeGreaterThanOrEqual(120);
      expect(description.length).toBeLessThanOrEqual(155);
      // Plus la description de /a-propos, ni celle du layout.
      expect(description).not.toBe(COMPANY_DESCRIPTION);
      expect(description).not.toMatch(/garantie|conforme|certifi|gratuit|illimit/i);
      expect(description.includes("notaires")).toBe(pilots);
      expect(metadata.alternates?.canonical).toBe("/");
      expect(metadata.openGraph).toMatchObject({
        url: "/",
        images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
      });
      vi.unstubAllEnvs();
    },
    30_000,
  );
});

describe("pillar page /ventes-immobilieres-judiciaires", () => {
  it("has its own title, a 140-155 character description and Open Graph data", async () => {
    const { metadata } = await import("./ventes-immobilieres-judiciaires/page");
    expect(titleText(metadata)).toEqual({
      text: "Vente immobilière judiciaire : guide de l’adjudication",
      absolute: true,
    });
    expect(titleText(metadata).text.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    const description = String(metadata.description);
    expect(description.length).toBeGreaterThanOrEqual(140);
    expect(description.length).toBeLessThanOrEqual(155);
    expect(metadata.alternates?.canonical).toBe("/ventes-immobilieres-judiciaires");
    expect(metadata.openGraph).toMatchObject({
      url: "/ventes-immobilieres-judiciaires",
      images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
    });
  });
});

describe("legal and institutional pages", () => {
  it.each([
    ["legal", () => import("./legal/page")],
    ["privacy", () => import("./privacy/page")],
    ["contact", () => import("./contact/page")],
    ["conditions-generales", () => import("./conditions-generales/page")],
    ["a-propos", () => import("./a-propos/page")],
    ["classement-des-annonces", () => import("./classement-des-annonces/page")],
  ])("%s has a descriptive, sober description", async (_name, importPage) => {
    const { metadata } = await importPage();
    const description = String(metadata.description);
    // More than the former one-liners, and no promise or legal claim (nothing but a table of
    // contents of the page).
    expect(description.length).toBeGreaterThanOrEqual(90);
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description).not.toMatch(/garantie|conforme|certifi|gratuit|illimit/i);
    expect(titleText(metadata).text.length + TITLE_SUFFIX.length).toBeLessThanOrEqual(
      MAX_TITLE_LENGTH,
    );
  });
});
