const UA = "immojudis-flood-risk/1.0 (+https://immojudis.com)";
const pts = [[0.689,47.399],[4.89992,44.04024],[4.73031,43.5573],[2.28258,48.84446],[4.36131,43.83611],[-1.38736,47.26913],[3.89275,43.60676],[2.32003,48.84826],[2.34957,48.84292],[5.46133,43.51474]];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, ko = {};
for (let i = 0; i < 40; i++) {
  const [lon, lat] = pts[i % pts.length];
  const url = i % 2 ? `https://www.georisques.gouv.fr/api/v1/tri_zonage?latlon=${lon},${lat}` : `https://www.georisques.gouv.fr/api/v1/gaspar/tri?code_insee=37261`;
  await sleep(400);
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA }, redirect: "error", signal: AbortSignal.timeout(8000) });
    await r.text(); ok++;
    if (!r.ok) ko["http_" + r.status] = (ko["http_" + r.status] ?? 0) + 1;
  } catch (e) { const c = e.cause?.code ?? e.cause?.message ?? e.message; ko[c] = (ko[c] ?? 0) + 1; }
}
console.log(JSON.stringify({ ok, ko }));
