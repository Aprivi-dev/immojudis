import { describe, expect, it, vi } from "vitest";
import type { Resend } from "resend";
import sharp from "sharp";
import { fetchInboundAttachments, readBoundedAttachment } from "@/lib/information-agent-inbound";
import {
  MAX_PUBLISHED_PHOTO_BYTES,
  optimizeInformationAgentPhoto,
} from "@/lib/information-agent-image";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: vi.fn(), storage: { from: vi.fn() } },
}));

describe("information agent photo attachments", () => {
  it("reads all pages of an email with more than twenty photos", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          data: Array.from({ length: 100 }, (_, index) => ({ id: `photo-${index}` })),
          has_more: true,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { data: [{ id: "photo-100" }], has_more: false },
        error: null,
      });
    const resend = { emails: { receiving: { attachments: { list } } } } as unknown as Resend;
    const result = await fetchInboundAttachments(resend, "email-1");
    expect(result.attachments).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(list).toHaveBeenNthCalledWith(2, { emailId: "email-1", limit: 100, after: "photo-99" });
  });

  it("bounds actual downloaded bytes even when the provider declares a smaller size", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(6));
          controller.enqueue(new Uint8Array(6));
          controller.close();
        },
      }),
    );
    expect(await readBoundedAttachment(response, 10)).toBeNull();
  });

  it("creates a small WebP derivative with bounded dimensions", async () => {
    const original = await sharp({
      create: { width: 2600, height: 1800, channels: 3, background: "#aabbcc" },
    })
      .png()
      .toBuffer();
    const output = await optimizeInformationAgentPhoto(original);
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBeLessThanOrEqual(1920);
    expect(metadata.height).toBeLessThanOrEqual(1920);
    expect(output.byteLength).toBeLessThanOrEqual(MAX_PUBLISHED_PHOTO_BYTES);
    expect(metadata.exif).toBeUndefined();
  });

  it.each(["jpeg", "png", "webp"] as const)("opens and converts %s photos", async (format) => {
    const source = sharp({
      create: { width: 1200, height: 800, channels: 3, background: "#aabbcc" },
    });
    const original = await source.toFormat(format).toBuffer();
    const output = await optimizeInformationAgentPhoto(original);
    expect((await sharp(output).metadata()).format).toBe("webp");
    expect(output.byteLength).toBeLessThanOrEqual(MAX_PUBLISHED_PHOTO_BYTES);
  });

  it("does not publish an unreadable image", async () => {
    await expect(optimizeInformationAgentPhoto(new Uint8Array([1, 2, 3]))).rejects.toThrow(
      "illisible",
    );
  });
});
