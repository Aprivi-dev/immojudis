import { describe, expect, it } from "vitest";
import { fetchPpriPerimeter } from "./land-planning-ppri";
import {
  FLOOD_API_USER_AGENT,
  fetchCommuneTri,
  fetchLandRisks,
  fetchTriZonage,
  isoDateFromFrench,
} from "./land-risks-provider";
import { parsePprn, parseTriZonage } from "./land-risks/parsers";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Réponses réelles de l'API Géorisques relevées le 26/10/2026 (champs utiles seulement). */
const TOURS = {
  results: 1,
  data: [
    {
      code_national_tri: "45DREAL20130002",
      identifiant_tri: "FRG_TRI_TOURS",
      libelle_tri: "Vallée de la Loire et du Cher dans l'agglomération de Tours",
      cours_deau: "la Loire",
      typeInondation: { code: "01", libelle: "débordement de cours d'eau" },
      scenario: { code: "01For", libelle: "aléa de forte probabilité" },
      date_arrete_carte: "18/12/2013",
      code_insee: "37261",
      libelle_commune: "TOURS",
    },
  ],
  response_code: 200,
  message: null,
};
const BORDEAUX = {
  results: 2,
  data: [
    {
      code_national_tri: "33DREAL20130140",
      libelle_tri: "BORDEAUX",
      typeInondation: { code: "01", libelle: "débordement de cours d'eau" },
      scenario: { code: "04Fai", libelle: "aléa de faible probabilité" },
      date_arrete_carte: null,
    },
    {
      code_national_tri: "33DREAL20130140",
      libelle_tri: "BORDEAUX",
      typeInondation: { code: "03", libelle: "submersion marine" },
      scenario: { code: "02Moy", libelle: "aléa de probabilité moyenne" },
      date_arrete_carte: null,
    },
  ],
  response_code: 200,
};
const NOTHING = { results: 0, data: [], response_code: 200, message: null };

function recorder(answer: (url: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return answer(url);
  };
  return { calls, fetcher };
}

describe("fetchTriZonage (appartenance à la zone d'un TRI)", () => {
  it("Loire à Tours : une entrée 01/01For ; la requête est un latlon sans rayon, avec un User-Agent", async () => {
    const { calls, fetcher } = recorder(() => json(TOURS));
    const result = await fetchTriZonage({ longitude: 0.689, latitude: 47.399 }, { fetcher });
    expect(result).toEqual({ kind: "ok", scenarios: ["01For"], mapDate: "2013-12-18" });
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/tri_zonage");
    expect(url.searchParams.get("latlon")).toBe("0.689,47.399");
    expect(url.searchParams.has("rayon")).toBe(false);
    expect(calls[0].headers["User-Agent"]).toBe(FLOOD_API_USER_AGENT);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it("Bordeaux : un scénario par type d'inondation, aucun n'est « forte probabilité »", async () => {
    const { fetcher } = recorder(() => json(BORDEAUX));
    const result = await fetchTriZonage({ longitude: -0.559, latitude: 44.846 }, { fetcher });
    expect(result).toEqual({ kind: "ok", scenarios: ["04Fai", "02Moy"], mapDate: null });
  });

  it("Montmartre : aucune entrée, le point n'est dans aucune zone", async () => {
    const { fetcher } = recorder(() => json(NOTHING));
    expect(await fetchTriZonage({ longitude: 2.342, latitude: 48.8867 }, { fetcher })).toEqual({
      kind: "ok",
      scenarios: [],
      mapDate: null,
    });
  });

  it("un 429 est rendu à part (coupe-circuit de la passe)", async () => {
    const { fetcher } = recorder(() => json({ message: "API rate limit exceeded" }, 429));
    expect(await fetchTriZonage({ longitude: 0.689, latitude: 47.399 }, { fetcher })).toEqual({
      kind: "rate_limited",
    });
  });

  it("une erreur ne rend qu'un code : jamais l'URL, la coordonnée ni la réponse", async () => {
    const { fetcher } = recorder(() => json({ message: "boom 0.689,47.399" }, 503));
    const result = await fetchTriZonage({ longitude: 0.689, latitude: 47.399 }, { fetcher });
    expect(result).toEqual({ kind: "failure", code: "http_503" });
    expect(JSON.stringify(result)).not.toMatch(/0\.689|47\.399|georisques/);
  });

  it("une panne réseau ou un délai donnent un code, jamais le message de l'erreur", async () => {
    const network = await fetchTriZonage(
      { longitude: 0.689, latitude: 47.399 },
      {
        fetcher: async () => {
          throw new Error("getaddrinfo ENOTFOUND www.georisques.gouv.fr?latlon=0.689,47.399");
        },
      },
    );
    expect(network).toEqual({ kind: "failure", code: "network" });
    const timeout = await fetchTriZonage(
      { longitude: 0.689, latitude: 47.399 },
      {
        timeoutMs: 50,
        fetcher: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    );
    expect(timeout).toEqual({ kind: "failure", code: "timeout" });
  });

  it("une réponse de forme inattendue n'est pas prise pour « hors zone »", async () => {
    const { fetcher } = recorder(() => json({ unexpected: true }));
    expect(await fetchTriZonage({ longitude: 0.689, latitude: 47.399 }, { fetcher })).toEqual({
      kind: "failure",
      code: "unexpected_shape",
    });
  });

  it("une entrée sans code de scénario reconnu est un échec « forme inattendue », jamais un « ok » vide", async () => {
    const entry = (scenario: unknown) => ({
      code_national_tri: "45DREAL20130002",
      libelle_tri: "Tours",
      scenario,
    });
    for (const scenario of [
      undefined,
      null,
      {},
      { code: "" },
      { code: "99Xxx" },
      { libelle: "aléa de forte probabilité" },
    ]) {
      const { fetcher } = recorder(() => json({ results: 1, data: [entry(scenario)] }));
      expect(
        await fetchTriZonage({ longitude: 0.689, latitude: 47.399 }, { fetcher }),
        JSON.stringify(scenario),
      ).toEqual({ kind: "failure", code: "unexpected_shape" });
    }
  });

  it("une seule entrée sans scénario reconnu parmi des entrées valides suffit pour un échec", async () => {
    const { fetcher } = recorder(() =>
      json({
        results: 2,
        data: [
          { code_national_tri: "X", libelle_tri: "A", scenario: { code: "01For" } },
          { code_national_tri: "X", libelle_tri: "A", scenario: { code: "inconnu" } },
        ],
      }),
    );
    expect(await fetchTriZonage({ longitude: 0.689, latitude: 47.399 }, { fetcher })).toEqual({
      kind: "failure",
      code: "unexpected_shape",
    });
  });

  it.each(["01For", "02Moy", "03Mcc", "04Fai"])("reconnaît le scénario %s", async (code) => {
    const { fetcher } = recorder(() =>
      json({
        results: 1,
        data: [{ code_national_tri: "X", libelle_tri: "A", scenario: { code } }],
      }),
    );
    expect(await fetchTriZonage({ longitude: 0.689, latitude: 47.399 }, { fetcher })).toMatchObject(
      {
        kind: "ok",
        scenarios: [code],
      },
    );
  });

  it("refuse des coordonnées invalides sans appel", async () => {
    const { calls, fetcher } = recorder(() => json(NOTHING));
    expect(await fetchTriZonage({ longitude: 400, latitude: 47 }, { fetcher })).toEqual({
      kind: "failure",
      code: "invalid_position",
    });
    expect(calls).toHaveLength(0);
  });

  it("applique la cadence demandée avant chaque appel", async () => {
    let paced = 0;
    const { fetcher } = recorder(() => json(NOTHING));
    await fetchTriZonage(
      { longitude: 0.689, latitude: 47.399 },
      {
        fetcher,
        pace: async () => {
          paced += 1;
        },
      },
    );
    expect(paced).toBe(1);
  });
});

describe("fetchCommuneTri (la commune compte-t-elle un TRI ?)", () => {
  it("Tours : oui ; commune sans TRI : non (liste vide, HTTP 200)", async () => {
    const yes = recorder(() =>
      json({
        results: 1,
        page: 1,
        total_pages: 1,
        data: [{ code_national_tri: "45DREAL20130002", libelle_tri: "Tours", code_insee: "37261" }],
      }),
    );
    expect(await fetchCommuneTri("37261", { fetcher: yes.fetcher })).toEqual({
      kind: "ok",
      hasTri: true,
    });
    const url = new URL(yes.calls[0].url);
    expect(url.pathname).toBe("/api/v1/gaspar/tri");
    expect(url.searchParams.get("code_insee")).toBe("37261");

    const no = recorder(() => json({ results: 0, page: 1, total_pages: 0, data: [] }));
    expect(await fetchCommuneTri("02691", { fetcher: no.fetcher })).toEqual({
      kind: "ok",
      hasTri: false,
    });
  });

  it("429 et erreurs : mêmes codes que pour le point", async () => {
    expect(
      await fetchCommuneTri("37261", { fetcher: recorder(() => json({}, 429)).fetcher }),
    ).toEqual({ kind: "rate_limited" });
    expect(
      await fetchCommuneTri("37261", { fetcher: recorder(() => json({}, 500)).fetcher }),
    ).toEqual({ kind: "failure", code: "http_500" });
    expect(await fetchCommuneTri("pas-un-code")).toEqual({
      kind: "failure",
      code: "invalid_commune",
    });
  });
});

describe("redirections refusées (TRI, GASPAR, PM1)", () => {
  /** Comme `fetch` : avec `redirect: "error"`, une réponse 302 fait échouer l'appel. */
  function redirecting() {
    const inits: Array<RequestInit | undefined> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      inits.push(init);
      if (init?.redirect === "error") throw new TypeError("fetch failed");
      return new Response(null, { status: 302, headers: { location: "https://autre.example/" } });
    };
    return { inits, fetcher };
  }

  it("TRI : un 302 donne un échec, jamais un « hors zone »", async () => {
    const { inits, fetcher } = redirecting();
    expect(await fetchTriZonage({ longitude: 0.689, latitude: 47.399 }, { fetcher })).toEqual({
      kind: "failure",
      code: "network",
    });
    expect(inits[0]?.redirect).toBe("error");
  });

  it("GASPAR (commune) : un 302 donne un échec", async () => {
    const { inits, fetcher } = redirecting();
    expect(await fetchCommuneTri("37261", { fetcher })).toEqual({
      kind: "failure",
      code: "network",
    });
    expect(inits[0]?.redirect).toBe("error");
  });

  it("PM1 : un 302 donne un échec, jamais un « hors périmètre »", async () => {
    const { inits, fetcher } = redirecting();
    expect(await fetchPpriPerimeter({ longitude: 0.689, latitude: 47.399 }, { fetcher })).toEqual({
      kind: "failure",
      code: "network",
    });
    expect(inits[0]?.redirect).toBe("error");
  });

  it("une réponse 302 rendue telle quelle (sans suivi) est aussi un échec http_302", async () => {
    const asResponse: typeof fetch = async () => new Response(null, { status: 302 });
    expect(
      await fetchTriZonage({ longitude: 0.689, latitude: 47.399 }, { fetcher: asResponse }),
    ).toEqual({
      kind: "failure",
      code: "http_302",
    });
    expect(await fetchCommuneTri("37261", { fetcher: asResponse })).toEqual({
      kind: "failure",
      code: "http_302",
    });
    expect(
      await fetchPpriPerimeter({ longitude: 0.689, latitude: 47.399 }, { fetcher: asResponse }),
    ).toEqual({ kind: "failure", code: "http_302" });
  });

  it("le dossier du terrain, lui, ne change pas : ses appels ne portent pas l'option", async () => {
    const inits: Array<RequestInit | undefined> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      inits.push(init);
      return json(NOTHING);
    };
    await fetchLandRisks(
      { parcels: [], coordinates: { longitude: 0.689, latitude: 47.399 }, codeInsee: "37261" },
      { token: null, fetcher },
    );
    expect(inits.length).toBeGreaterThan(5);
    expect(inits.every((init) => init?.redirect === undefined)).toBe(true);
  });
});

describe("isoDateFromFrench", () => {
  it("lit jj/mm/aaaa", () => {
    expect(isoDateFromFrench("18/12/2013")).toBe("2013-12-18");
    expect(isoDateFromFrench("2013-12-18")).toBeNull();
    expect(isoDateFromFrench(null)).toBeNull();
  });
});

describe("couche TRI du dossier du terrain : appartenance, plus un rayon de 1 000 m", () => {
  it("interroge tri_zonage au point, sans rayon, en v1 ; une zone donne un constat « point »", async () => {
    const { calls, fetcher } = recorder((url) =>
      url.includes("/tri_zonage") ? json(TOURS) : json(NOTHING),
    );
    const result = await fetchLandRisks(
      { parcels: [], coordinates: { longitude: 0.689, latitude: 47.399 }, codeInsee: "37261" },
      { token: null, fetcher },
    );
    const request = calls.find((call) => call.url.includes("/tri_zonage"))!;
    expect(new URL(request.url).searchParams.get("latlon")).toBe("0.689,47.399");
    expect(request.url).not.toContain("rayon=");
    expect(calls.some((call) => call.url.includes("/gaspar/tri"))).toBe(false);
    const tri = result.findings.find((finding) => finding.label.startsWith("Territoire à risque"));
    expect(tri).toMatchObject({
      category: "flood",
      scope: "point",
      status: "mapped",
      level: "aléa de forte probabilité",
    });
    expect(tri?.description).toContain("est situé dans la zone cartographiée");
    expect(result.checks.find((check) => check.key === "tri")?.scope).toBe("point");
  });

  it("un point hors de toute zone ne produit aucun constat TRI", async () => {
    const { fetcher } = recorder(() => json(NOTHING));
    const result = await fetchLandRisks(
      { parcels: [], coordinates: { longitude: 2.342, latitude: 48.8867 }, codeInsee: "75118" },
      { token: null, fetcher },
    );
    expect(result.findings.some((finding) => finding.label.startsWith("Territoire à risque"))).toBe(
      false,
    );
    expect(result.checks.find((check) => check.key === "tri")?.status).toBe("empty");
  });

  it("position « commune » (sans coordonnées) : information TRI au niveau de la commune (GASPAR), pas « non vérifiée »", async () => {
    const { calls, fetcher } = recorder((url) =>
      url.includes("/gaspar/tri")
        ? json({
            results: 1,
            data: [
              { code_national_tri: "45DREAL20130002", libelle_tri: "Tours", code_insee: "37261" },
            ],
          })
        : json(NOTHING),
    );
    const result = await fetchLandRisks(
      { parcels: [], coordinates: null, codeInsee: "37261" },
      { token: null, fetcher },
    );
    const request = calls.find((call) => call.url.includes("/gaspar/tri"))!;
    expect(new URL(request.url).searchParams.get("code_insee")).toBe("37261");
    expect(calls.some((call) => call.url.includes("/tri_zonage"))).toBe(false);
    const check = result.checks.find((entry) => entry.key === "tri");
    expect(check).toMatchObject({ status: "available", scope: "commune" });
    const finding = result.findings.find((entry) => entry.label.startsWith("Commune comprise"));
    expect(finding).toMatchObject({ category: "flood", scope: "commune" });
    // Un résultat communal ne dit pas que le bien est dans la zone.
    expect(finding?.description).toContain("ne dit pas si le bien se trouve dans la zone");
    expect(finding?.description).not.toContain("est situé dans la zone");
  });

  it("position « commune » dans une commune sans TRI : couche vide, sans constat", async () => {
    const { fetcher } = recorder(() => json(NOTHING));
    const result = await fetchLandRisks(
      { parcels: [], coordinates: null, codeInsee: "75118" },
      { token: null, fetcher },
    );
    expect(result.checks.find((entry) => entry.key === "tri")).toMatchObject({
      status: "empty",
      scope: "commune",
    });
    expect(result.findings.some((entry) => entry.label.startsWith("Commune comprise"))).toBe(false);
  });

  it("sans coordonnées ni commune : la couche TRI reste « non vérifiée »", async () => {
    const { calls, fetcher } = recorder(() => json(NOTHING));
    const result = await fetchLandRisks(
      { parcels: [], coordinates: null, codeInsee: null },
      { token: null, fetcher },
    );
    expect(calls).toHaveLength(0);
    expect(result.checks.find((entry) => entry.key === "tri")?.status).toBe("not_checked");
  });

  it("en v2, même sans coordonnées, la couche TRI n'est pas interrogée (écart documenté)", async () => {
    const { calls, fetcher } = recorder(() => json({ content: [] }));
    const result = await fetchLandRisks(
      { parcels: [], coordinates: null, codeInsee: "37261" },
      { token: "jeton", fetcher },
    );
    expect(calls.some((call) => call.url.includes("tri"))).toBe(false);
    expect(result.checks.find((entry) => entry.key === "tri")?.status).toBe("not_checked");
  });

  it("en v2 la couche n'est pas interrogée (aucune opération tri_zonage en v2) et le dit", async () => {
    const { calls, fetcher } = recorder(() => json({ content: [] }));
    const result = await fetchLandRisks(
      { parcels: [], coordinates: { longitude: 0.689, latitude: 47.399 }, codeInsee: "37261" },
      { token: "jeton", fetcher },
    );
    expect(calls.some((call) => call.url.includes("tri"))).toBe(false);
    expect(result.checks.find((check) => check.key === "tri")?.status).toBe("not_checked");
  });
});

describe("rayon des couches de proximité : le même en v1 et en v2", () => {
  const input = {
    parcels: [],
    coordinates: { longitude: 3.28, latitude: 49.84 },
    codeInsee: "02691",
  };

  it("v1 et v2 interrogent 1 000 m autour du point et le disent (portée « rayon »)", async () => {
    const v1 = recorder(() => json({ results: [{ identifiant: "m1", type: "Glissement" }] }));
    const v1Result = await fetchLandRisks(input, { token: null, fetcher: v1.fetcher });
    const v2 = recorder(() => json({ content: [{ identifiant: "m1", type: "Glissement" }] }));
    const v2Result = await fetchLandRisks(input, { token: "jeton", fetcher: v2.fetcher });

    expect(
      new URL(v1.calls.find((call) => call.url.includes("/v1/mvt"))!.url).searchParams.get("rayon"),
    ).toBe("1000");
    expect(
      new URL(v2.calls.find((call) => call.url.includes("/v2/mvt"))!.url).searchParams.get("rayon"),
    ).toBe("1000");
    expect(v1Result.checks.find((check) => check.key === "mvt")?.scope).toBe("radius");
    expect(v2Result.checks.find((check) => check.key === "mvt")?.scope).toBe("radius");
    // Les couches de point et de commune n'ont pas de rayon.
    expect(v2.calls.find((call) => call.url.includes("/v2/rga"))!.url).not.toContain("rayon=");
    expect(v2.calls.find((call) => call.url.includes("/v2/radon"))!.url).not.toContain("rayon=");
  });

  it("en v2, une parcelle fournie prime : requête parcellaire, pas de rayon", async () => {
    const { calls, fetcher } = recorder(() => json({ content: [] }));
    await fetchLandRisks(
      {
        ...input,
        parcels: [
          {
            id: "02691000CT0190",
            codeInsee: "02691",
            section: "CT",
            number: "0190",
            prefix: "000",
            surfaceM2: 1,
            geometry: null as never,
            match: "stored_reference",
            sourceUrl: "https://cadastre.data.gouv.fr/",
          },
        ],
      },
      { token: "jeton", fetcher },
    );
    const mvt = calls.find((call) => call.url.includes("/v2/mvt"))!.url;
    expect(mvt).toContain("codesParcelle=");
    expect(mvt).not.toContain("rayon=");
  });
});

describe("parsePprn : le niveau n'est jamais un booléen", () => {
  it("« etatRevision » booléen ou numérique : pas de niveau (et non « true » ou « false »)", () => {
    for (const etat of [true, false, 3]) {
      const [finding] = parsePprn({
        idGaspar: "1",
        libPpr: "PPRI de la Loire",
        etatRevision: etat,
      });
      expect(finding.level ?? null, String(etat)).toBeNull();
    }
  });

  it("garde un état textuel et le zonage réglementaire signalé", () => {
    expect(parsePprn({ idGaspar: "1", libPpr: "PPRI", etatRevision: "Approuvé" })[0].level).toBe(
      "Approuvé",
    );
    expect(
      parsePprn({
        idGaspar: "1",
        libPpr: "PPRI",
        etatRevision: false,
        zonageReglementaire: { zoneRegExists: true },
      })[0].level,
    ).toBe("zonage réglementaire signalé");
  });
});

describe("parseTriZonage", () => {
  it("décrit une appartenance, avec le type d'inondation, le scénario et la date de la carte", () => {
    const [finding] = parseTriZonage(TOURS);
    expect(finding.category).toBe("flood");
    expect(finding.label).toContain("Territoire à risque important d’inondation");
    expect(finding.level).toBe("aléa de forte probabilité");
    expect(finding.description).toContain("débordement de cours d'eau");
    expect(finding.description).toContain(
      "ni classement réglementaire de la parcelle ni état des risques",
    );
    expect(finding.regulatory).toBe(false);
  });

  it("une réponse vide ne donne aucun constat", () => {
    expect(parseTriZonage(NOTHING)).toEqual([]);
  });
});

describe("fetchPpriPerimeter (servitude PM1, aléa inondation)", () => {
  const feature = (alea: unknown) => ({
    type: "Feature",
    geometry: { type: "MultiPolygon", coordinates: [] },
    properties: { suptype: "pm1", idsup: "PM1-1", code_alea: alea },
  });

  it("Loire à Tours : code_alea 11, dans le périmètre ; la requête ne porte que la catégorie et le point", async () => {
    const { calls, fetcher } = recorder(() =>
      json({ type: "FeatureCollection", features: [feature("11")] }),
    );
    expect(await fetchPpriPerimeter({ longitude: 0.689, latitude: 47.399 }, { fetcher })).toEqual({
      kind: "ok",
      inPerimeter: true,
    });
    const url = new URL(calls[0].url);
    expect(url.hostname).toBe("apicarto.ign.fr");
    expect(url.pathname).toBe("/api/gpu/generateur-sup-s");
    expect(url.searchParams.get("categorie")).toBe("PM1");
    expect(JSON.parse(url.searchParams.get("geom")!)).toEqual({
      type: "Point",
      coordinates: [0.689, 47.399],
    });
  });

  it("Montmartre : une servitude PM1 d'un autre aléa (code 12) n'est pas un périmètre d'inondation", async () => {
    const { fetcher } = recorder(() =>
      json({ type: "FeatureCollection", features: [feature("12")] }),
    );
    expect(await fetchPpriPerimeter({ longitude: 2.342, latitude: 48.8867 }, { fetcher })).toEqual({
      kind: "ok",
      inPerimeter: false,
    });
  });

  it("le code d'aléa peut être un nombre ; aucune servitude : hors périmètre", async () => {
    expect(
      await fetchPpriPerimeter(
        { longitude: 0.689, latitude: 47.399 },
        {
          fetcher: recorder(() => json({ type: "FeatureCollection", features: [feature(11)] }))
            .fetcher,
        },
      ),
    ).toEqual({ kind: "ok", inPerimeter: true });
    expect(
      await fetchPpriPerimeter(
        { longitude: 2.364, latitude: 48.8443 },
        { fetcher: recorder(() => json({ type: "FeatureCollection", features: [] })).fetcher },
      ),
    ).toEqual({ kind: "ok", inPerimeter: false });
  });

  it("429, erreur, forme inattendue : des codes, jamais d'URL ni de coordonnée", async () => {
    const run = (response: () => Response) =>
      fetchPpriPerimeter(
        { longitude: 0.689, latitude: 47.399 },
        { fetcher: recorder(response).fetcher },
      );
    expect(await run(() => json({}, 429))).toEqual({ kind: "rate_limited" });
    expect(await run(() => json({}, 502))).toEqual({ kind: "failure", code: "http_502" });
    expect(await run(() => json({ error: "x" }))).toEqual({
      kind: "failure",
      code: "unexpected_shape",
    });
  });
});
