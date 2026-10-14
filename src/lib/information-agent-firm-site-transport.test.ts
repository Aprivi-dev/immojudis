import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Transport HTTPS réel (`createHttpsTransport`) avec `node:https` simulé : aucun socket n'est ouvert.
 * On vérifie le plafond de contenu décompressé, les en-têtes émis et l'abandon.
 */

type FakeResponse = {
  status: number;
  headers: Record<string, string>;
  chunks: Buffer[];
};

const fake = vi.hoisted(() => ({
  response: null as null | FakeResponse,
  options: null as null | Record<string, unknown>,
}));

vi.mock("node:https", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const { Readable: Source } = await import("node:stream");
  return {
    request: (options: Record<string, unknown>, callback: (res: unknown) => void) => {
      fake.options = options;
      const req = new Emitter() as EventEmitter & { end: () => void };
      req.end = () => {
        const signal = options.signal as AbortSignal | undefined;
        if (signal?.aborted) {
          req.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        const { status, headers, chunks } = fake.response!;
        const res = Object.assign(Source.from(chunks, { objectMode: false }), {
          statusCode: status,
          headers,
          complete: true,
        });
        setImmediate(() => callback(res));
      };
      return req;
    },
  };
});

import { createHttpsTransport } from "@/lib/information-agent/firm-site-search";

const lookupImpl = async () => [{ address: "93.184.216.34" }];

function run(maxBytes = 1_048_576, signal: AbortSignal = AbortSignal.timeout(5_000)) {
  return createHttpsTransport({ lookupImpl })({
    url: new URL("https://www.cabinet-dupont.fr/contact?x=1"),
    headers: { "user-agent": "ImmojudisAdresses/1.0 (+https://immojudis.com/contact)" },
    signal,
    maxBytes,
    dnsTimeoutMs: 1_000,
  });
}

beforeEach(() => {
  fake.options = null;
  fake.response = {
    status: 200,
    headers: { "content-type": "text/html" },
    chunks: [Buffer.from("<p>contact@cabinet-dupont.fr</p>")],
  };
});

describe("transport HTTPS de la recherche d'adresse", () => {
  it("émet un GET HTTPS sur le port 443 avec le nom d'hôte d'origine et une résolution contrôlée", async () => {
    const response = await run();
    expect(response).toEqual({
      status: 200,
      location: null,
      contentType: "text/html",
      body: "<p>contact@cabinet-dupont.fr</p>",
      truncated: false,
    });
    expect(fake.options).toMatchObject({
      protocol: "https:",
      hostname: "www.cabinet-dupont.fr",
      port: 443,
      path: "/contact?x=1",
      method: "GET",
      agent: false,
    });
    expect(fake.options?.lookup).toBeTypeOf("function");
    expect(fake.options?.headers).toMatchObject({
      "user-agent": "ImmojudisAdresses/1.0 (+https://immojudis.com/contact)",
    });
  });

  it("ne suit pas les redirections et ne lit pas le corps d'une réponse hors 2xx", async () => {
    fake.response = {
      status: 302,
      headers: { location: "https://autre.example/", "content-type": "text/html" },
      chunks: [Buffer.from("<p>corps</p>")],
    };
    expect(await run()).toEqual({
      status: 302,
      location: "https://autre.example/",
      contentType: "text/html",
      body: "",
      truncated: false,
    });
  });

  it("coupe un contenu de plus de 1 Mio et le signale", async () => {
    const big = Buffer.alloc(1_048_576 + 5_000, "a");
    fake.response = {
      status: 200,
      headers: { "content-type": "text/html" },
      chunks: [big.subarray(0, 600_000), big.subarray(600_000)],
    };
    const response = await run();
    expect(response.truncated).toBe(true);
    expect(Buffer.byteLength(response.body)).toBe(1_048_576);
  });

  it("applique le plafond au contenu DÉCOMPRESSÉ (bombe de décompression)", async () => {
    const bomb = gzipSync(Buffer.alloc(8 * 1_048_576, "a"));
    expect(bomb.length).toBeLessThan(100_000);
    fake.response = {
      status: 200,
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
      chunks: [bomb],
    };
    const response = await run();
    expect(response.truncated).toBe(true);
    expect(Buffer.byteLength(response.body)).toBe(1_048_576);
  });

  it("décompresse un contenu gzip ordinaire", async () => {
    fake.response = {
      status: 200,
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
      chunks: [gzipSync(Buffer.from("<p>cabinet@cabinet-dupont.fr</p>"))],
    };
    expect(await run()).toMatchObject({
      body: "<p>cabinet@cabinet-dupont.fr</p>",
      truncated: false,
    });
  });

  it("refuse un encodage inconnu", async () => {
    fake.response = {
      status: 200,
      headers: { "content-type": "text/html", "content-encoding": "compress" },
      chunks: [Buffer.from("x")],
    };
    await expect(run()).rejects.toThrow("Encodage");
  });

  it("abandonne la requête quand le signal est déjà abandonné", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(1024, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("transmet le signal à la requête", async () => {
    const signal = AbortSignal.timeout(5_000);
    await run(1024, signal);
    expect(fake.options?.signal).toBe(signal);
  });
});
