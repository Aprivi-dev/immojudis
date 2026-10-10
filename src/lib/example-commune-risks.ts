import { GASPAR_SOURCE_URL, type CommuneRiskProfile } from "@/lib/environment-reference";

/**
 * Snapshot of the real GASPAR profile of Bordeaux (base of 5 October 2026),
 * shown on the example listing, whose identifier is not a catalogue sale.
 */
export const EXAMPLE_COMMUNE_RISKS: CommuneRiskProfile = {
  status: "ready",
  commune: { code: "33063", name: "Bordeaux" },
  risks: [
    { code: "11", label: "Inondation" },
    { code: "112", label: "Par une crue à débordement lent de cours d'eau" },
    { code: "12", label: "Mouvement de terrain" },
    { code: "127", label: "Tassements différentiels" },
    { code: "13", label: "Séisme" },
    { code: "18", label: "Radon" },
    { code: "21", label: "Risque industriel" },
  ],
  catnatTotal: 50,
  catnatByType: [
    { code: "ICB", label: "Inondations et/ou Coulées de Boue", count: 23 },
    { code: "SEC", label: "Sécheresse", count: 22 },
    { code: "CMV", label: "Chocs Mécaniques liés à l'action des Vagues", count: 3 },
    { code: "MVT", label: "Mouvement de Terrain", count: 1 },
    { code: "TMP", label: "Tempête", count: 1 },
  ],
  catnatRecent: [
    {
      code: "ICB",
      label: "Inondations et/ou Coulées de Boue",
      start: "2024-06-17",
      end: "2024-06-18",
      decree: "2024-07-21",
      published: "2024-08-02",
    },
    {
      code: "SEC",
      label: "Sécheresse",
      start: "2022-07-01",
      end: "2022-09-30",
      decree: "2023-04-03",
      published: "2023-05-03",
    },
    {
      code: "ICB",
      label: "Inondations et/ou Coulées de Boue",
      start: "2021-06-17",
      end: "2021-06-19",
      decree: "2021-06-30",
      published: "2021-07-02",
    },
  ],
  preventionPlans: [
    {
      family: "PPRN",
      kind: "PPRN-I",
      label: "PPR Bordeaux (revision)",
      status: "Approuvé",
      prescribedOn: "2012-03-02",
      approvedOn: "2023-12-05",
      risks: ["Par une crue à débordement lent de cours d'eau", "Par submersion marine"],
    },
  ],
  seismicZone: 2,
  radonClass: 2,
  snapshot: "2026-10-05",
  sourceUrl: GASPAR_SOURCE_URL,
};
