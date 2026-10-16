import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PHOTO_MIRROR_MAX_URLS,
  fetchPhotoMirrors,
  isPhotoMirrorEnabled,
  isPhotoMirrorUrl,
  mirrorFromRow,
  photoMirrorForCard,
  photoMirrorForDetail,
  photoMirrorUrl,
  withPhotoMirror,
  withPhotoMirrors,
  type PhotoMirrorClient,
} from "./photo-mirror";
import type { SaleMedia } from "./types";

const BASE = "https://ci.supabase.co/storage/v1/object/public/sale-photos/";
const LICITOR = "https://www.licitor.com/photos/maison.jpg";
const VENCH = "https://www.vench.fr/vignettes/v1.jpg";

function row(sourceUrl: string, overrides: Record<string, unknown> = {}) {
  return {
    source_url: sourceUrl,
    path_640: "sale-1/abc-640.webp",
    path_1600: "sale-1/abc-1600.webp",
    width: 1600,
    height: 1200,
    ...overrides,
  };
}

function clientReturning(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { client: { rpc } as PhotoMirrorClient, rpc };
}

function sale(id: string, ...urls: string[]) {
  return { id, media: urls.map((url) => ({ type: "image", url }) as SaleMedia) };
}

describe("photo mirrors", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://ci.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "on");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("interrupteur", () => {
    it("n'est ouvert que par la valeur « on »", () => {
      expect(isPhotoMirrorEnabled("on")).toBe(true);
      for (const value of ["", "off", "true", "1", "ON", " on"]) {
        expect(isPhotoMirrorEnabled(value)).toBe(false);
      }
    });

    it("absent de l'environnement : éteint", () => {
      vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", undefined);
      expect(isPhotoMirrorEnabled()).toBe(false);
    });

    it("éteint : aucun appel, la liste est renvoyée telle quelle", async () => {
      vi.stubEnv("NEXT_PUBLIC_PHOTO_MIRROR", "");
      const { client, rpc } = clientReturning([row(LICITOR)]);
      const sales = [sale("a", LICITOR)];

      expect(await withPhotoMirrors(sales, client)).toBe(sales);
      expect(await withPhotoMirror(sales[0]!, client)).toBe(sales[0]);
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe("un seul appel par page", () => {
    it("n'envoie que la 1re photo de chaque vente, sans doublon, en un appel", async () => {
      const { client, rpc } = clientReturning([]);

      await withPhotoMirrors(
        [
          sale("a", LICITOR, "https://www.licitor.com/photos/b.jpg"),
          sale("b", VENCH),
          sale("c", LICITOR),
        ],
        client,
      );

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("sale_photo_mirrors", { p_source_urls: [LICITOR, VENCH] });
    });

    it("limite l'appel à 100 URL distinctes", async () => {
      const { client, rpc } = clientReturning([]);
      const sales = Array.from({ length: 150 }, (_, index) =>
        sale(`s${index}`, `https://www.licitor.com/photos/${index}.jpg`),
      );

      await withPhotoMirrors(sales, client);

      const urls = rpc.mock.calls[0]![1].p_source_urls as string[];
      expect(urls).toHaveLength(PHOTO_MIRROR_MAX_URLS);
      expect(new Set(urls).size).toBe(PHOTO_MIRROR_MAX_URLS);
    });

    it("sur une fiche, cherche toutes les photos de la vente", async () => {
      const other = "https://www.licitor.com/photos/b.jpg";
      const { client, rpc } = clientReturning([]);

      await withPhotoMirror(sale("a", LICITOR, other), client);

      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]![1].p_source_urls).toEqual([LICITOR, other]);
    });

    it("n'appelle rien quand aucune vente n'a de photo", async () => {
      const { client, rpc } = clientReturning([]);
      await withPhotoMirrors(
        [
          { id: "a", media: [] },
          { id: "b", media: null },
        ],
        client,
      );
      expect(rpc).not.toHaveBeenCalled();
    });
  });

  describe("enrichissement", () => {
    it("ajoute la copie sans toucher à l'URL d'origine ni aux données d'entrée", async () => {
      const { client } = clientReturning([row(LICITOR)]);
      const input = [sale("a", LICITOR), sale("b", VENCH)];

      const [first, second] = await withPhotoMirrors(input, client);

      expect(first!.media[0]).toEqual({
        type: "image",
        url: LICITOR,
        mirror: {
          path640: "sale-1/abc-640.webp",
          path1600: "sale-1/abc-1600.webp",
          width: 1600,
          height: 1200,
        },
      });
      expect(second).toBe(input[1]);
      expect(input[0]!.media[0]).not.toHaveProperty("mirror");
    });

    it("ne copie que la 1re photo d'une vente en liste", async () => {
      const second = "https://www.licitor.com/photos/b.jpg";
      const { client } = clientReturning([row(second, { path_640: "sale-1/zzz-640.webp" })]);

      const [result] = await withPhotoMirrors([sale("a", LICITOR, second)], client);

      expect(result!.media.every((item) => !item.mirror)).toBe(true);
    });

    it("sur une fiche, rattache la copie à la bonne photo", async () => {
      const second = "https://www.licitor.com/photos/b.jpg";
      const { client } = clientReturning([row(second)]);

      const result = await withPhotoMirror(sale("a", LICITOR, second), client);

      expect(result.media[0]!.mirror).toBeUndefined();
      expect(result.media[1]!.mirror?.path640).toBe("sale-1/abc-640.webp");
    });

    it("renvoie la même liste quand aucune copie n'existe", async () => {
      const { client } = clientReturning([]);
      const sales = [sale("a", LICITOR)];
      expect(await withPhotoMirrors(sales, client)).toBe(sales);
    });

    it("ignore une copie dont l'original serait écarté (logo, bannière) ou sans dimensions", async () => {
      expect(mirrorFromRow(row(LICITOR, { width: 200, height: 200 }))).toBeNull();
      expect(mirrorFromRow(row(LICITOR, { width: 3000, height: 600 }))).toBeNull();
      expect(mirrorFromRow(row(LICITOR, { width: null, height: null }))).toBeNull();
      expect(mirrorFromRow(row(LICITOR, { path_640: null }))).toBeNull();
      expect(mirrorFromRow(row(LICITOR, { path_640: "../secret.webp" }))).toBeNull();
      expect(mirrorFromRow(row(LICITOR, { path_1600: null }))?.path1600).toBeNull();
    });
  });

  describe("pannes", () => {
    it("une erreur de la fonction laisse la page inchangée et se contente d'un journal", async () => {
      const { client } = clientReturning(null, { message: "function does not exist" });
      const sales = [sale("a", LICITOR)];

      expect(await withPhotoMirrors(sales, client)).toBe(sales);
      expect(console.warn).toHaveBeenCalledWith(expect.any(String), "function does not exist");
    });

    it("un appel qui lève ou une réponse inattendue donnent le même résultat", async () => {
      const throwing = { rpc: vi.fn().mockRejectedValue(new Error("réseau")) };
      const weird = clientReturning({ not: "an array" });
      const sales = [sale("a", LICITOR)];

      expect(await withPhotoMirrors(sales, throwing as unknown as PhotoMirrorClient)).toBe(sales);
      expect(await withPhotoMirrors(sales, weird.client)).toBe(sales);
      expect(console.warn).toHaveBeenCalledTimes(2);
    });

    it("un délai dépassé (300 ms) abandonne les copies sans attendre la réponse", async () => {
      vi.useFakeTimers();
      const rpc = vi.fn(() => new Promise(() => undefined));
      const sales = [sale("a", LICITOR)];

      const pending = withPhotoMirrors(sales, { rpc } as unknown as PhotoMirrorClient);
      await vi.advanceTimersByTimeAsync(299);
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toBe(sales);
      expect(console.warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("300"));
    });

    it("sans client (Supabase non configuré), ne fait rien", async () => {
      const sales = [sale("a", LICITOR)];
      expect(await withPhotoMirrors(sales, null)).toBe(sales);
      expect((await fetchPhotoMirrors(null, [LICITOR])).size).toBe(0);
    });
  });

  describe("URL et affichage", () => {
    const mirror = {
      path640: "sale-1/abc-640.webp",
      path1600: "sale-1/abc-1600.webp",
      width: 1600,
      height: 1200,
    };

    it("construit l'URL publique du bucket", () => {
      expect(photoMirrorUrl("sale-1/abc-640.webp")).toBe(`${BASE}sale-1/abc-640.webp`);
      expect(photoMirrorUrl("../x.webp")).toBeNull();
      expect(photoMirrorUrl("/x.webp")).toBeNull();
      expect(photoMirrorUrl(null)).toBeNull();
    });

    it("sans URL Supabase, aucune copie n'est affichable", () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      expect(photoMirrorUrl("sale-1/abc-640.webp")).toBeNull();
      expect(photoMirrorForCard(mirror)).toBeNull();
    });

    it("la carte reçoit la copie 640 px seule", () => {
      expect(photoMirrorForCard(mirror)).toEqual({ src: `${BASE}sale-1/abc-640.webp` });
    });

    it("la fiche reçoit un srcset 640w / 1600w, la grande copie par défaut", () => {
      expect(photoMirrorForDetail(mirror)).toEqual({
        src: `${BASE}sale-1/abc-1600.webp`,
        srcSet: `${BASE}sale-1/abc-640.webp 640w, ${BASE}sale-1/abc-1600.webp 1600w`,
      });
      expect(photoMirrorForDetail({ ...mirror, path1600: null })).toEqual({
        src: `${BASE}sale-1/abc-640.webp`,
      });
      expect(photoMirrorForDetail(null)).toBeNull();
    });

    it("reconnaît une URL de copie, pas celle d'une source", () => {
      expect(isPhotoMirrorUrl(`${BASE}sale-1/abc-640.webp`)).toBe(true);
      expect(isPhotoMirrorUrl(LICITOR)).toBe(false);
      expect(isPhotoMirrorUrl(undefined)).toBe(false);
    });
  });
});
