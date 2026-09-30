import {
  allowedTarget,
  handler,
  normalizeRedirectLocation,
  redirectDiagnostic,
} from "./handler.ts";
import { TOKEN_SHA256 } from "./auth.ts";

Deno.test("restrict origins and POST forms", () => {
  const cases: [string, string, string, boolean][] = [
    ["https://www.petitesaffiches.fr/encheres-immobilieres/", "GET", "", true],
    [
      "https://www.petitesaffiches.fr/vente/immobiliere/judiciaire/une-cave-cannes-166037.html",
      "GET",
      "",
      true,
    ],
    [
      "https://www.petitesaffiches.fr/vente/immobiliere/volontaire/une-maison-antibes-166038.html",
      "GET",
      "",
      true,
    ],
    [
      "https://www.petitesaffiches.fr/vente/immobiliere/n/un-appartement-a-juvisy-sur-orge-165935.html",
      "GET",
      "",
      true,
    ],
    ["https://www.petitesaffiches.fr/vente/immobiliere/judiciaire/private", "GET", "", false],
    [
      "https://www.petitesaffiches.fr/vente/immobiliere/n/not-an-id.html",
      "GET",
      "",
      false,
    ],
    [
      "https://www.petitesaffiches.fr/vente/immobiliere/judiciaire/une-cave-cannes-166037.html?token=secret",
      "GET",
      "",
      false,
    ],
    [
      "https://www.petitesaffiches.fr/vente/immobiliere/n/un-appartement-a-juvisy-sur-orge-165935.html?token=secret",
      "GET",
      "",
      false,
    ],
    ["https://cessions.immobilier-etat.gouv.fr/?page=1", "GET", "", true],
    [
      "https://www.petitesaffiches.fr/encheres-immobilieres/",
      "POST",
      "historique=0&select_dep=06",
      true,
    ],
    [
      "https://www.petitesaffiches.fr/encheres-immobilieres/",
      "POST",
      "historique=0&delete=1",
      false,
    ],
    ["https://www.petitesaffiches.fr/admin", "GET", "", false],
    ["http://www.petitesaffiches.fr/encheres-immobilieres/", "GET", "", false],
    [
      "http://www.petitesaffiches.fr/vente/immobiliere/n/un-appartement-a-juvisy-sur-orge-165935.html",
      "GET",
      "",
      false,
    ],
    ["https://evil.example/", "GET", "", false],
    [
      "https://evil.example/vente/immobiliere/n/un-appartement-a-juvisy-sur-orge-165935.html",
      "GET",
      "",
      false,
    ],
    ["https://www.petitesaffiches.fr.evil.example/", "GET", "", false],
    ["https://user:pass@www.petitesaffiches.fr/", "GET", "", false],
    [
      "https://www.petitesaffiches.fr:444/vente/immobiliere/n/un-appartement-a-juvisy-sur-orge-165935.html",
      "GET",
      "",
      false,
    ],
    ["https://cessions.immobilier-etat.gouv.fr/", "POST", "", false],
    ["http://cessions.immobilier-etat.gouv.fr/", "GET", "", false],
  ];
  for (const [url, method, body, expected] of cases) {
    if (allowedTarget(url, method, body) !== expected) throw new Error(url);
  }
});

Deno.test("unauthorized callers cannot fetch", async () => {
  const response = await handler(
    new Request("https://relay.invalid", {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
      body: JSON.stringify({ url: "https://www.petitesaffiches.fr/" }),
    }),
  );
  if (response.status !== 401) throw new Error("Authentication failed open");
});

Deno.test("redirect diagnostics keep only status and safe host/path", () => {
  const diagnostic = redirectDiagnostic(
    301,
    "http://www.petitesaffiches.fr/encheres-immobilieres/?token=secret-value#fragment",
    "https://www.petitesaffiches.fr/encheres-immobilieres/",
  );
  if (diagnostic.status !== 301) throw new Error("redirect status missing");
  if (diagnostic.destinationHost !== "www.petitesaffiches.fr") {
    throw new Error("host missing");
  }
  if (diagnostic.destinationPath !== "/encheres-immobilieres/") {
    throw new Error("path missing");
  }
  const serialized = JSON.stringify(diagnostic);
  if (
    serialized.includes("token") ||
    serialized.includes("secret-value") ||
    serialized.includes("fragment")
  ) {
    throw new Error("redirect query or fragment leaked");
  }

  const relative = redirectDiagnostic(
    302,
    "/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html?session=secret",
    "https://www.petitesaffiches.fr/encheres-immobilieres/",
  );
  if (relative.destinationHost !== "www.petitesaffiches.fr") {
    throw new Error("relative host missing");
  }
  if (
    relative.destinationPath !== "/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html"
  ) {
    throw new Error("relative path missing");
  }
  if (JSON.stringify(relative).includes("session")) {
    throw new Error("relative query leaked");
  }

  const publicDetail = redirectDiagnostic(
    301,
    "http://www.petitesaffiches.fr/vente/immobiliere/judiciaire/une-cave-cannes-166037.html?token=secret",
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/judiciaire/une-cave-a-cannes-59033.html",
  );
  if (publicDetail.destinationPath !== "/vente/immobiliere/") {
    throw new Error("canonical detail path was not reduced to its public prefix");
  }
  if (
    JSON.stringify(publicDetail).includes("cannes") ||
    JSON.stringify(publicDetail).includes("secret")
  ) {
    throw new Error("canonical detail identity or query leaked");
  }

  const publicNDetail = redirectDiagnostic(
    301,
    "http://www.petitesaffiches.fr/vente/immobiliere/n/un-appartement-a-juvisy-sur-orge-165935.html?token=secret",
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/judiciaire/un-appartement-a-juvisy-sur-orge-58923.html",
  );
  if (publicNDetail.destinationPath !== "/vente/immobiliere/") {
    throw new Error("n detail path was not reduced to its public prefix");
  }
  if (
    JSON.stringify(publicNDetail).includes("juvisy") ||
    JSON.stringify(publicNDetail).includes("secret")
  ) {
    throw new Error("n detail identity or query leaked");
  }

  const opaquePath = redirectDiagnostic(
    302,
    "https://www.petitesaffiches.fr/private/secret-token-value",
    "https://www.petitesaffiches.fr/",
  );
  if (opaquePath.destinationHost !== "www.petitesaffiches.fr") {
    throw new Error("opaque path host missing");
  }
  if (opaquePath.destinationPath !== null) {
    throw new Error("opaque path leaked");
  }

  const cessionsDetail = redirectDiagnostic(
    302,
    "https://cessions.immobilier-etat.gouv.fr/biens/secret-token-value",
    "https://cessions.immobilier-etat.gouv.fr/",
  );
  if (cessionsDetail.destinationHost !== "cessions.immobilier-etat.gouv.fr") {
    throw new Error("Cessions host missing");
  }
  if (cessionsDetail.destinationPath !== "/biens/") {
    throw new Error("Cessions detail path was not reduced to its public prefix");
  }

  const externalSecret = redirectDiagnostic(
    302,
    "https://secret-token.evil.example/redirected",
    "https://www.petitesaffiches.fr/",
  );
  if (externalSecret.destinationHost !== null || externalSecret.destinationPath !== null) {
    throw new Error("external redirect host was logged");
  }
  if (JSON.stringify(externalSecret).includes("secret-token")) {
    throw new Error("external redirect hostname leaked");
  }
});

Deno.test("redirect diagnostics reject credentials and bound long paths", () => {
  const credentialed = redirectDiagnostic(
    307,
    "https://user:password@www.petitesaffiches.fr/private",
    "https://www.petitesaffiches.fr/",
  );
  if (credentialed.destinationHost !== null || credentialed.destinationPath !== null) {
    throw new Error("redirect credentials accepted");
  }

  const alternatePort = redirectDiagnostic(
    302,
    "https://www.petitesaffiches.fr:444/vente/immobiliere/n/une-cave-166037.html",
    "https://www.petitesaffiches.fr/vente/immobiliere/n/une-cave-166037.html",
  );
  if (alternatePort.destinationHost !== null || alternatePort.destinationPath !== null) {
    throw new Error("alternate redirect port entered diagnostics");
  }

  const longPath = redirectDiagnostic(
    308,
    `https://www.petitesaffiches.fr/encheres-immobilieres/ventes-aux-encheres-immobilieres-p${"1".repeat(
      700,
    )}.html`,
    "https://www.petitesaffiches.fr/",
  );
  if (longPath.destinationPath !== null) {
    throw new Error("long redirect path was not bounded");
  }
});

Deno.test("normalizes only the verified Petites Affiches HTTP canonical redirect", () => {
  const normalized = normalizeRedirectLocation(
    301,
    "http://www.petitesaffiches.fr/encheres-immobilieres/",
    "https://www.petitesaffiches.fr/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html",
  );
  if (normalized !== "https://www.petitesaffiches.fr/encheres-immobilieres/") {
    throw new Error(`unexpected normalized redirect: ${normalized}`);
  }
  if (!allowedTarget(normalized, "GET", "")) {
    throw new Error("normalized redirect is not an allowed HTTPS target");
  }

  const sameUrl = normalizeRedirectLocation(
    301,
    "http://www.petitesaffiches.fr/encheres-immobilieres/",
    "https://www.petitesaffiches.fr/encheres-immobilieres/",
  );
  if (sameUrl !== "http://www.petitesaffiches.fr/encheres-immobilieres/") {
    throw new Error("canonical redirect loop was not blocked");
  }

  const queryBearing = normalizeRedirectLocation(
    301,
    "http://www.petitesaffiches.fr/encheres-immobilieres/?token=secret",
    "https://www.petitesaffiches.fr/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html",
  );
  if (queryBearing !== "http://www.petitesaffiches.fr/encheres-immobilieres/?token=secret") {
    throw new Error("query-bearing redirect was rewritten");
  }
  const sourceQuery = normalizeRedirectLocation(
    301,
    "http://www.petitesaffiches.fr/encheres-immobilieres/",
    "https://www.petitesaffiches.fr/encheres-immobilieres/?session=secret",
  );
  if (sourceQuery !== "http://www.petitesaffiches.fr/encheres-immobilieres/") {
    throw new Error("source query-bearing redirect was rewritten");
  }

  const detailLocation =
    "http://www.petitesaffiches.fr/vente/immobiliere/judiciaire/une-cave-cannes-166037.html";
  const normalizedDetail = normalizeRedirectLocation(
    301,
    detailLocation,
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/judiciaire/une-cave-a-cannes-59033.html",
  );
  if (
    normalizedDetail !==
      "https://www.petitesaffiches.fr/vente/immobiliere/judiciaire/une-cave-cannes-166037.html" ||
    !allowedTarget(normalizedDetail, "GET", "")
  ) {
    throw new Error("verified public detail redirect was not made fetchable");
  }
  if (
    normalizeRedirectLocation(
      301,
      `${detailLocation}?token=secret`,
      "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/judiciaire/une-cave-a-cannes-59033.html",
    ) !== `${detailLocation}?token=secret`
  ) {
    throw new Error("query-bearing detail redirect was rewritten");
  }

  const nDetailLocation =
    "http://www.petitesaffiches.fr/vente/immobiliere/n/un-appartement-a-juvisy-sur-orge-165935.html";
  const normalizedNDetail = normalizeRedirectLocation(
    301,
    nDetailLocation,
    "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/judiciaire/un-appartement-a-juvisy-sur-orge-58923.html",
  );
  if (
    normalizedNDetail !==
    "https://www.petitesaffiches.fr/vente/immobiliere/n/un-appartement-a-juvisy-sur-orge-165935.html"
  ) {
    throw new Error("verified n detail redirect was not made fetchable");
  }
  if (!allowedTarget(normalizedNDetail, "GET", "")) {
    throw new Error("normalized n detail redirect is not an allowed HTTPS target");
  }
  if (
    normalizeRedirectLocation(
      301,
      `${nDetailLocation}?token=secret`,
      "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/judiciaire/un-appartement-a-juvisy-sur-orge-58923.html",
    ) !== `${nDetailLocation}?token=secret`
  ) {
    throw new Error("query-bearing n detail redirect was rewritten");
  }

  for (const [status, location] of [
    [302, "http://www.petitesaffiches.fr/encheres-immobilieres/"],
    [301, "http://www.petitesaffiches.fr/other/"],
    [301, "http://evil.example/encheres-immobilieres/"],
  ] as const) {
    if (
      normalizeRedirectLocation(status, location, "https://www.petitesaffiches.fr/other") !==
      location
    ) {
      throw new Error("unverified redirect was rewritten");
    }
  }
});

Deno.test("relay refuses unsafe Locations without forwarding their URL", async () => {
  const originalDigest = crypto.subtle.digest;
  const originalFetch = globalThis.fetch;
  const digestBytes = Uint8Array.from(
    TOKEN_SHA256.match(/.{2}/g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
  (crypto.subtle as unknown as { digest: () => Promise<ArrayBuffer> }).digest = async () =>
    digestBytes.slice().buffer;

  let upstreamLocation = "https://evil.example/collect?token=secret-value";
  let upstreamStatus = 302;
  globalThis.fetch = async () => new Response("upstream body", {
    status: upstreamStatus,
    headers: { location: upstreamLocation },
  });
  try {
    for (const location of [
      "https://evil.example/collect?token=secret-value",
      "https://user:password@www.petitesaffiches.fr/vente/immobiliere/n/une-cave-166037.html?token=secret-value",
    ]) {
      upstreamLocation = location;
      const response = await handler(
        new Request("https://relay.invalid", {
          method: "POST",
          headers: { authorization: "Bearer test-token" },
          body: JSON.stringify({
            url: "https://www.petitesaffiches.fr/encheres-immobilieres/",
          }),
        }),
      );
      if (response.status !== 502) throw new Error("unsafe redirect was not rejected");
      if (response.headers.has("location")) throw new Error("unsafe Location was forwarded");
      const body = await response.text();
      if (body.includes("evil.example") || body.includes("secret-value")) {
        throw new Error("unsafe redirect leaked in the response");
      }
    }

    upstreamLocation = "http://www.petitesaffiches.fr/encheres-immobilieres/";
    upstreamStatus = 301;
    const allowed = await handler(
      new Request("https://relay.invalid", {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: JSON.stringify({
          url: "https://www.petitesaffiches.fr/encheres-immobilieres/ventes-aux-encheres-immobilieres-p2.html",
        }),
      }),
    );
    if (allowed.status !== 301) throw new Error("public redirect status was not preserved");
    if (
      allowed.headers.get("location") !==
      "https://www.petitesaffiches.fr/encheres-immobilieres/"
    ) {
      throw new Error("public redirect was not normalized safely");
    }
  } finally {
    globalThis.fetch = originalFetch;
    (crypto.subtle as unknown as { digest: typeof originalDigest }).digest = originalDigest;
  }
});
