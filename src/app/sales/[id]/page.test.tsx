import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock("@/lib/public-sale.server", () => ({ lookupPublicSale: mocks.lookup }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  },
}));
vi.mock("./sale-detail-page", () => ({
  SaleDetailPage: ({ id }: { id: string }) => <div data-testid="detail">{id}</div>,
}));

import Page, { generateMetadata, generateStaticParams, revalidate } from "./page";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const sale = {
  id: ID,
  property_type: "apartment",
  app_surface_m2: 50,
  city: "Romainville",
  department: "93",
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  sale_date: "2099-10-20T09:00:00+02:00",
  starting_price_eur: 85_000,
  tribunal: "TJ Bobigny",
  media: [{ type: "image", url: "https://media.example.test/photo.jpg" }],
};
const params = Promise.resolve({ id: ID });

describe("public sale page", () => {
  beforeEach(() => {
    mocks.lookup.mockReset();
    process.env.SITE_URL = "https://immojudis.com";
  });

  it("answers 404 for a sale that is not public", async () => {
    mocks.lookup.mockResolvedValue({ status: "missing" });
    await expect(Page({ params })).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  it("keeps a missing sale out of search engines", async () => {
    mocks.lookup.mockResolvedValue({ status: "missing" });
    const metadata = await generateMetadata({ params });
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe("Annonce introuvable");
    expect(metadata.alternates).toBeUndefined();
  });

  it("builds per-sale metadata without repeating the site name", async () => {
    mocks.lookup.mockResolvedValue({ status: "found", sale });
    const metadata = await generateMetadata({ params });
    expect(metadata.title).toBe("Appartement 50 m² à Romainville (93) – tribunal");
    expect(String(metadata.title)).not.toMatch(/immojudis/i);
    expect(metadata.description).toMatch(
      /^Appartement 50 m² à Romainville \(93\), vente au tribunal/,
    );
    expect(metadata.alternates).toEqual({ canonical: `/sales/${ID}` });
    expect(metadata.openGraph).toMatchObject({ siteName: "Immojudis", locale: "fr_FR" });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
    expect(metadata.robots).toBeUndefined();
  });

  it("renders the sale with its structured data, in absolute URLs", async () => {
    mocks.lookup.mockResolvedValue({ status: "found", sale });
    const html = renderToStaticMarkup(await Page({ params }));
    const json = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)![1];
    const data = JSON.parse(json.replaceAll("\\u003c", "<"));
    expect(data["@graph"][0].url).toBe(`https://immojudis.com/sales/${ID}`);
    expect(data["@graph"][0].offers.availability).toBe("https://schema.org/LimitedAvailability");
    expect(data["@graph"][1]["@type"]).toBe("Event");
    expect(html).toContain('data-testid="detail"');
  });

  it("still renders when the server cannot read the sale, without structured data", async () => {
    mocks.lookup.mockResolvedValue({ status: "unavailable" });
    const html = renderToStaticMarkup(await Page({ params }));
    expect(html).not.toContain("ld+json");
    expect((await generateMetadata({ params })).robots).toEqual({ index: false, follow: false });
  });

  it("is generated on demand and refreshed at most every five minutes", async () => {
    expect(revalidate).toBe(300);
    expect(await generateStaticParams()).toEqual([]);
  });
});
