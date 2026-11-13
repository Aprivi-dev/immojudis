import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), upload: vi.fn() }));

vi.mock("@/integrations/supabase/lazy", () => ({
  hasSupabaseAuthHint: () => true,
  getSupabase: async () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: "jeton" } } }) },
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({ uploadToSignedUrl: mocks.upload }) } },
}));

import {
  fetchPublicationRequestsClient,
  submitPublicationRequestClient,
  type PublicationRequestFields,
} from "./publication-requests-client";

const fields: PublicationRequestFields = {
  title: "Maison à Nantes",
  location: "Nantes",
  startingPrice: "120 000",
  hearingDate: "",
  court: "",
  description: "Maison de ville",
  strengths: "",
  cautions: "",
  anonymizeDocuments: true,
  documentTypes: [],
  promotionOptions: [],
  files: [new File(["%PDF"], "ccv.pdf", { type: "application/pdf" })],
};

const target = {
  requestId: "req-1",
  uploads: [
    {
      bucket: "publication-requests",
      path: "u/req-1/ccv.pdf",
      token: "t",
      name: "ccv.pdf",
      size: 4,
      mime_type: "application/pdf",
      uploaded_at: "2026-11-13T10:00:00Z",
      ordinal: 0,
    },
  ],
};

const call = (index: number) => mocks.fetch.mock.calls[index] as [string, RequestInit];

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.upload.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("demandes de publication côté navigateur", () => {
  it("lit la liste avec le jeton du compte et le délai d'une lecture", async () => {
    mocks.fetch.mockResolvedValue(Response.json({ requests: [], hasMore: false, nextPage: null }));

    await fetchPublicationRequestsClient(2);

    const [path, init] = call(0);
    expect(path).toBe("/api/publication-requests?page=2");
    expect(init).toMatchObject({ headers: { Authorization: "Bearer jeton" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("prépare les pièces, les téléverse puis enregistre la demande, sans délai d'écriture", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json(target))
      .mockResolvedValueOnce(Response.json({ request: { id: "req-1" } }));
    mocks.upload.mockResolvedValue({ error: null });

    await expect(submitPublicationRequestClient(fields)).resolves.toEqual({
      request: { id: "req-1" },
    });

    expect(call(0)[1]).toMatchObject({ method: "PUT", signal: undefined });
    expect(JSON.parse(call(0)[1].body as string)).toEqual({
      files: [{ name: "ccv.pdf", size: 4, mime_type: "application/pdf" }],
    });
    const [, save] = call(1);
    expect(save).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer jeton", "Content-Type": "application/json" },
    });
    expect(JSON.parse(save.body as string)).toMatchObject({
      requestId: "req-1",
      fields: { startingPriceEur: 120000, hearingDate: null },
      documents: [{ path: "u/req-1/ccv.pdf", name: "ccv.pdf" }],
    });
  });

  it("retire les pièces téléversées quand l'enregistrement échoue, puis lève l'erreur", async () => {
    mocks.fetch
      .mockResolvedValueOnce(Response.json(target))
      .mockResolvedValueOnce(Response.json({ error: "Demande invalide." }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    mocks.upload.mockResolvedValue({ error: null });

    await expect(submitPublicationRequestClient(fields)).rejects.toMatchObject({
      message: "Demande invalide.",
      status: 422,
    });

    const [path, cleanup] = call(2);
    expect(path).toBe("/api/publication-requests");
    expect(cleanup.method).toBe("DELETE");
    expect(JSON.parse(cleanup.body as string)).toEqual({ requestId: "req-1" });
  });
});
