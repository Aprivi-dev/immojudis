import { describe, expect, it, vi } from "vitest";
import { fetchPublicSaleSummary, SALE_ID_PATTERN } from "./public-sale-summary";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const row = {
  id: ID,
  starting_price_eur: 54_500,
  sale_venue_type: "notary",
  sale_verification_status: "cross_checked",
  city: "Tancarville",
  department: "76",
  property_type: "house",
  sale_date: "2026-11-04T17:00:00+00:00",
  app_surface_m2: 78,
  app_surface_kind: "habitable",
  rooms_count: 3,
  bedrooms_count: 2,
  bathrooms_count: 1,
  tribunal_name: null,
  tribunal_city: null,
  thumbnail_url:
    "https://media.immobilier.notaires.fr/inotr/media/1/76065/2084645/2f4198e8_VGA.jpg",
  updated_at: "2026-10-08T08:29:21Z",
};

describe("public sale summary", () => {
  it("maps the card-level facts of a public sale", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [row], error: null });
    const result = await fetchPublicSaleSummary({ rpc }, ID);
    expect(rpc).toHaveBeenCalledWith("get_public_sale_summary", { p_sale_id: ID });
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.sale).toMatchObject({
      id: ID,
      city: "Tancarville",
      department: "76",
      app_surface_m2: 78,
      media: [{ type: "image", url: row.thumbnail_url }],
    });
    expect(result.sale).not.toHaveProperty("thumbnail_url");
    expect(result.sale).not.toHaveProperty("address");
  });

  it("reports a sale outside the public catalogue as missing", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    expect(await fetchPublicSaleSummary({ rpc }, ID)).toEqual({ kind: "missing" });
  });

  it("does not even ask the database about something that is not an identifier", async () => {
    const rpc = vi.fn();
    expect(await fetchPublicSaleSummary({ rpc }, "not-a-uuid")).toEqual({ kind: "missing" });
    expect(await fetchPublicSaleSummary({ rpc }, "../../etc/passwd")).toEqual({ kind: "missing" });
    expect(rpc).not.toHaveBeenCalled();
    expect(SALE_ID_PATTERN.test("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("asks for the legacy preview while the function is not deployed", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.get_public_sale_summary",
      },
    });
    expect(await fetchPublicSaleSummary({ rpc }, ID)).toEqual({ kind: "unsupported" });
  });

  it("throws on any other error: a transient failure must not become a 404", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    await expect(fetchPublicSaleSummary({ rpc }, ID)).rejects.toMatchObject({ code: "57014" });
  });

  it("adds the public details of the listing without the visit text", async () => {
    const details = {
      land_surface_m2: 781,
      parking_count: 2,
      has_garden: true,
      has_terrace: false,
      has_garage: null,
      has_pool: false,
      has_air_conditioning: null,
      has_double_glazing: true,
      has_visit_dates: true,
      photo_count: 6,
      document_count: 4,
    };
    const rpc = vi.fn((fn: string) =>
      Promise.resolve({ data: [fn === "get_public_sale_details" ? details : row], error: null }),
    );
    const result = await fetchPublicSaleSummary({ rpc }, ID);
    expect(rpc).toHaveBeenCalledWith("get_public_sale_details", { p_sale_id: ID });
    if (result.kind !== "found") throw new Error("expected a sale");
    expect(result.sale).toMatchObject({
      city: "Tancarville",
      land_surface_m2: 781,
      has_garden: true,
      has_visit_dates: true,
      photo_count: 6,
      document_count: 4,
    });
    expect(result.sale).not.toHaveProperty("visit_dates");
  });

  it("keeps the summary alone while the details function is not deployed", async () => {
    const rpc = vi.fn((fn: string) =>
      Promise.resolve(
        fn === "get_public_sale_details"
          ? {
              data: null,
              error: {
                code: "PGRST202",
                message: "Could not find the function public.get_public_sale_details",
              },
            }
          : { data: [row], error: null },
      ),
    );
    const result = await fetchPublicSaleSummary({ rpc }, ID);
    expect(result.kind).toBe("found");
    if (result.kind === "found") expect(result.sale).not.toHaveProperty("photo_count");
  });
});
