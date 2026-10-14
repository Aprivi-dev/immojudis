import { describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";

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
    ["/sales", () => import("./sales/page")],
    ["/comment-ca-marche", () => import("./comment-ca-marche/page")],
    ["/annonce-exemple", () => import("./annonce-exemple/page")],
  ])("%s", async (_path, importPage) => {
    const { text, absolute } = titleText((await importPage()).metadata as Metadata);
    expect(absolute).toBe(false);
    expect(text.length + TITLE_SUFFIX.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
  });
});

describe("pillar page /ventes-immobilieres-judiciaires", () => {
  it("has its own title, a 140-155 character description and Open Graph data", async () => {
    const { metadata } = await import("./ventes-immobilieres-judiciaires/page");
    expect(titleText(metadata)).toEqual({
      text: "Vente immobilière judiciaire : guide complet de l'adjudication",
      absolute: true,
    });
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
