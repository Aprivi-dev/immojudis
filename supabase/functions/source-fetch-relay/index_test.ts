import {
  allowedTarget,
  handler,
  normalizeRedirectLocation,
  redirectDiagnostic,
} from "./handler.ts";

Deno.test("restrict origins and POST forms", () => {
  const cases: [string, string, string, boolean][] = [
    ["https://www.petitesaffiches.fr/encheres-immobilieres/", "GET", "", true],
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
    ["https://evil.example/", "GET", "", false],
    ["https://www.petitesaffiches.fr.evil.example/", "GET", "", false],
    ["https://user:pass@www.petitesaffiches.fr/", "GET", "", false],
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
