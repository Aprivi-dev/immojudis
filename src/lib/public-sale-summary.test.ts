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
  content_changed_at: "2026-10-08T08:29:21Z",
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

  it("carries the code of the tribunal (the address of its page), or none while the function is not migrated", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ ...row, sale_venue_type: "tribunal", tribunal_code: "justice_tj_1_93" }],
      error: null,
    });
    const result = await fetchPublicSaleSummary({ rpc }, ID);
    if (result.kind !== "found") throw new Error("expected a found sale");
    expect(result.sale.tribunal_code).toBe("justice_tj_1_93");

    const old = vi.fn().mockResolvedValue({ data: [row], error: null });
    const legacy = await fetchPublicSaleSummary({ rpc: old }, ID);
    if (legacy.kind !== "found") throw new Error("expected a found sale");
    expect(legacy.sale.tribunal_code).toBeNull();
  });

  it("carries the date of the last visible change, and nothing else as a modification date", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ ...row, updated_at: "2026-10-18T08:00:00Z" }],
      error: null,
    });
    const result = await fetchPublicSaleSummary({ rpc }, ID);
    if (result.kind !== "found") throw new Error("expected a found sale");
    expect(result.sale.content_changed_at).toBe("2026-10-08T08:29:21Z");
    // The technical date of the row is not part of the public sale.
    expect(result.sale).not.toHaveProperty("updated_at");
  });

  it("has no modification date when the sale never changed, or while the function is not migrated", async () => {
    for (const data of [
      { ...row, content_changed_at: null },
      (({ content_changed_at: _omitted, ...rest }) => rest)(row),
    ]) {
      const rpc = vi.fn().mockResolvedValue({ data: [data], error: null });
      const result = await fetchPublicSaleSummary({ rpc }, ID);
      if (result.kind !== "found") throw new Error("expected a found sale");
      expect(result.sale.content_changed_at).toBeNull();
    }
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

  describe("market gap band", () => {
    const answer = (band: unknown, error: unknown = null) =>
      vi.fn((fn: string) =>
        Promise.resolve(
          fn === "get_public_sale_market_gap_band"
            ? { data: error ? null : band, error }
            : { data: [row], error: null },
        ),
      );

    it("joins the public sale when the database has a band", async () => {
      for (const band of ["under", "near", "above", "insufficient"]) {
        const rpc = answer(band);
        const result = await fetchPublicSaleSummary({ rpc }, ID);
        expect(rpc).toHaveBeenCalledWith("get_public_sale_market_gap_band", { p_sale_id: ID });
        if (result.kind !== "found") throw new Error("expected a sale");
        expect(result.sale.market_gap_band).toBe(band);
      }
    });

    it("leaves the band out when the database has nothing to say", async () => {
      const result = await fetchPublicSaleSummary({ rpc: answer(null) }, ID);
      if (result.kind !== "found") throw new Error("expected a sale");
      expect(result.sale).not.toHaveProperty("market_gap_band");
    });

    it("never lets a figure or an unexpected answer through", async () => {
      for (const unexpected of [42, "-45 %", "120000", ["near"], { band: "near" }, "NEAR"]) {
        const result = await fetchPublicSaleSummary({ rpc: answer(unexpected) }, ID);
        if (result.kind !== "found") throw new Error("expected a sale");
        expect(result.sale).not.toHaveProperty("market_gap_band");
      }
    });

    it("keeps the sale, without band, while the function is missing or fails", async () => {
      for (const error of [
        { code: "PGRST202", message: "Could not find the function" },
        { code: "57014", message: "timeout" },
      ]) {
        const result = await fetchPublicSaleSummary({ rpc: answer(null, error) }, ID);
        expect(result.kind).toBe("found");
        if (result.kind === "found") expect(result.sale).not.toHaveProperty("market_gap_band");
      }
      const rpc = vi.fn((fn: string) =>
        fn === "get_public_sale_market_gap_band"
          ? Promise.reject(new Error("network"))
          : Promise.resolve({ data: [row], error: null }),
      );
      expect((await fetchPublicSaleSummary({ rpc }, ID)).kind).toBe("found");
    });
  });

  describe("indexability verdict of the database", () => {
    const answer = (verdict: unknown, error: unknown = null) =>
      vi.fn((fn: string) =>
        Promise.resolve(
          fn === "get_public_sale_indexability"
            ? { data: error ? null : verdict, error }
            : { data: [row], error: null },
        ),
      );

    it("is not asked for by default (the browser does not need it)", async () => {
      const rpc = answer(true);
      await fetchPublicSaleSummary({ rpc }, ID);
      expect(rpc).not.toHaveBeenCalledWith("get_public_sale_indexability", expect.anything());
    });

    it("is returned with the sale when asked for", async () => {
      for (const verdict of [true, false]) {
        const result = await fetchPublicSaleSummary({ rpc: answer(verdict) }, ID, {
          withIndexability: true,
        });
        expect(result).toMatchObject({ kind: "found", indexable: verdict });
      }
    });

    it("is left undefined while the function is not deployed", async () => {
      const rpc = answer(null, { code: "PGRST202", message: "Could not find the function" });
      const result = await fetchPublicSaleSummary({ rpc }, ID, { withIndexability: true });
      expect(result.kind).toBe("found");
      expect(result).not.toHaveProperty("indexable");
    });

    it("throws on any other error", async () => {
      const rpc = answer(null, { code: "57014", message: "timeout" });
      await expect(
        fetchPublicSaleSummary({ rpc }, ID, { withIndexability: true }),
      ).rejects.toMatchObject({ code: "57014" });
    });
  });
});
