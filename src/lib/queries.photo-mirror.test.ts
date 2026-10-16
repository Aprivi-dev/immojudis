// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  isSupabaseConfigured: true,
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
    auth: { getSession: mocks.getSession },
  },
}));

import { getSaleById, getSalePreviewById } from "./queries";

const ID = "005a914d-563c-427b-88a4-740cbf851afb";
const PHOTO = "https://www.licitor.com/photos/maison.jpg";
const mirrorRow = {
  source_url: PHOTO,
  path_640: `${ID}/abc-640.webp`,
  path_1600: `${ID}/abc-1600.webp`,
  width: 1600,
  height: 1200,
};

function mirrorReads() {
  return mocks.rpc.mock.calls.filter(([fn]) => fn === "sale_photo_mirrors");
}

describe("fiche lue par le navigateur : copie hébergée de la photo", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.from.mockReset();
    mocks.getSession.mockReset().mockResolvedValue({ data: { session: { user: { id: "u" } } } });
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  function readsFullSale() {
    mocks.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                id: ID,
                city: "Pau",
                media: [
                  { type: "image", url: PHOTO },
                  { type: "image", url: "https://www.licitor.com/photos/autre.jpg" },
                ],
              },
              error: null,
            }),
        }),
      }),
    });
  }

  it("fiche complète : toutes les photos sont cherchées en un appel, la copie est attachée", async () => {
    readsFullSale();
    mocks.rpc.mockResolvedValue({ data: [mirrorRow], error: null });

    const sale = await getSaleById(ID);

    expect(mirrorReads()).toHaveLength(1);
    expect(mirrorReads()[0]![1].p_source_urls).toEqual([
      PHOTO,
      "https://www.licitor.com/photos/autre.jpg",
    ]);
    expect(sale!.media![0]).toMatchObject({
      url: PHOTO,
      mirror: { path640: `${ID}/abc-640.webp` },
    });
    expect(sale!.media![1]).toEqual({
      type: "image",
      url: "https://www.licitor.com/photos/autre.jpg",
    });
  });

  it("fiche complète : une panne de la fonction laisse la fiche telle qu'avant", async () => {
    readsFullSale();
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const sale = await getSaleById(ID);

    expect(sale!.id).toBe(ID);
    expect(JSON.stringify(sale)).not.toContain("mirror");
  });

  it("fiche complète : interrupteur éteint, aucun appel", async () => {
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "");
    readsFullSale();

    await getSaleById(ID);

    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fiche publique : la vignette de la vente reçoit sa copie", async () => {
    mocks.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === "sale_photo_mirrors"
          ? { data: [mirrorRow], error: null }
          : fn === "get_public_sale_summary"
            ? {
                data: [
                  {
                    id: ID,
                    city: "Pau",
                    sale_venue_type: "tribunal",
                    sale_verification_status: "verified",
                    thumbnail_url: PHOTO,
                  },
                ],
                error: null,
              }
            : { data: null, error: { code: "PGRST202", message: fn } },
      ),
    );

    const sale = await getSalePreviewById(ID);

    expect(sale!.media![0]).toMatchObject({ url: PHOTO, mirror: { width: 1600 } });
    expect(mirrorReads()).toHaveLength(1);
  });
});
