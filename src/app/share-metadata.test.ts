import { describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";

// Only the metadata of the pages matters here: their loaders are replaced so that importing a
// page does not need a database.
vi.mock("@/lib/public-catalogue.server", () => ({ loadInitialCatalogue: vi.fn() }));
vi.mock("@/lib/public-tribunal-activity.server", () => ({
  loadPublicTribunalActivity: vi.fn(async () => ({ status: "ok", items: [{ code: "pau" }] })),
}));
vi.mock("@/lib/legal-documents", () => ({
  publicLegalPublisher: vi.fn(),
  legalPublisherConfigurationStatus: vi.fn(() => ({ ready: false, missing: [] })),
  legalConfigurationStatus: vi.fn(() => ({ ready: false, missing: [] })),
}));

const PAGES: Array<
  [
    string,
    string,
    () => Promise<{ metadata?: Metadata; generateMetadata?: () => Metadata | Promise<Metadata> }>,
  ]
> = [
  ["/comment-ca-marche", "comment-ca-marche", () => import("./comment-ca-marche/page")],
  ["/a-propos", "a-propos", () => import("./a-propos/page")],
  ["/offres", "offres", () => import("./offres/page")],
  ["/avocats", "avocats", () => import("./avocats/page")],
  ["/contact", "contact", () => import("./contact/page")],
  [
    "/simulateur-frais-encheres",
    "simulateur-frais-encheres",
    () => import("./simulateur-frais-encheres/page"),
  ],
  ["/tribunaux", "tribunaux", () => import("./tribunaux/page")],
  [
    "/classement-des-annonces",
    "classement-des-annonces",
    () => import("./classement-des-annonces/page"),
  ],
  ["/annonce-exemple", "annonce-exemple", () => import("./annonce-exemple/page")],
  [
    "/sales",
    "sales",
    async () => ({
      generateMetadata: async () =>
        (await import("./sales/page")).generateMetadata({ searchParams: Promise.resolve({}) }),
    }),
  ],
];

describe("share metadata of the public pages", () => {
  it.each(PAGES)(
    "%s has a canonical, an Open Graph card and a Twitter card",
    async (path, _n, load) => {
      const module = await load();
      const metadata = module.generateMetadata ? await module.generateMetadata() : module.metadata!;
      expect(metadata.alternates?.canonical).toBe(path);
      expect(metadata.openGraph).toMatchObject({
        url: path,
        siteName: "Immojudis",
        images: [{ url: "/opengraph-image", width: 1200, height: 630 }],
      });
      expect(String((metadata.openGraph as { title?: unknown }).title)).toBe(
        String(metadata.title),
      );
      expect(metadata.openGraph).toHaveProperty("description", metadata.description);
      expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
    },
  );

  it("keeps the explicit indexing choices of /annonce-exemple and /tribunaux", async () => {
    const example = (await import("./annonce-exemple/page")).metadata;
    expect(example.robots).toEqual({ index: true, follow: true });
    const courts = await (await import("./tribunaux/page")).generateMetadata();
    expect(courts.robots).toEqual({ index: true, follow: true });
  });
});
