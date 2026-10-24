import { z } from "zod/mini";

export const PILOT_KINDS = ["tribunal", "notary", "state"] as const;
export type PilotKind = (typeof PILOT_KINDS)[number];

export type PilotFact = {
  label: string;
  value: string | null;
  sourceUrl?: string | null;
  detail?: string;
};

export type PilotMilestone = {
  label: string;
  date: string | null;
  sourceUrl?: string | null;
};

export type PilotCheck = {
  id: string;
  label: string;
  reason: string;
  sourceUrl?: string | null;
};

export type PilotDefinition = {
  kind: PilotKind;
  title: string;
  description: string;
  priceLabel: string;
  packetLabel: string;
  counterpartyLabel: string;
  counterparty: string | null;
  facts: PilotFact[];
  milestones: PilotMilestone[];
  checks: PilotCheck[];
};

// zod/mini : le brouillon est validé dans le navigateur (espace de travail des pilotes) ; mêmes
// règles et mêmes valeurs par défaut que l'écriture chaînée de zod, avec bien moins de code envoyé.
// Un montant : nombre fini (zod 4 refuse déjà l'infini), de 0 à un milliard d'euros, `null` par défaut.
const pilotAmountSchema = () =>
  z._default(z.nullable(z.number().check(z.gte(0), z.lte(1_000_000_000))), null);

export const pilotDraftSchema = z.object({
  schemaVersion: z._default(z.literal(1), 1),
  kind: z.enum(PILOT_KINDS),
  priceEur: pilotAmountSchema(),
  acquisitionCostsEur: pilotAmountSchema(),
  worksEur: pilotAmountSchema(),
  carryingCostsEur: pilotAmountSchema(),
  exitValueEur: pilotAmountSchema(),
  financingEur: pilotAmountSchema(),
  targetProfitEur: pilotAmountSchema(),
  checkStatuses: z._default(z.record(z.string(), z.enum(["todo", "verified", "blocked"])), {}),
  documentStatuses: z._default(z.record(z.string(), z.enum(["todo", "reviewed", "question"])), {}),
  documentNotes: z._default(z.record(z.string(), z.string().check(z.maxLength(1000))), {}),
  questions: z._default(z.string().check(z.maxLength(5000)), ""),
  nextAction: z._default(z.string().check(z.maxLength(300)), ""),
  nextActionAt: z._default(z.nullable(z.string().check(z.maxLength(32))), null),
  updatedAt: z._default(z.nullable(z.string().check(z.iso.datetime())), null),
  workspaceRevision: z._default(
    z.nullable(z.string().check(z.iso.datetime({ offset: true }))),
    null,
  ),
});

export type PilotDraft = z.infer<typeof pilotDraftSchema>;

export function emptyPilotDraft(kind: PilotKind): PilotDraft {
  return pilotDraftSchema.parse({ kind });
}

export function pilotEconomics(draft: PilotDraft) {
  const costs = [draft.priceEur, draft.acquisitionCostsEur, draft.worksEur, draft.carryingCostsEur];
  const totalInvestment = costs.every((value) => value !== null)
    ? costs.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  const marginEur =
    totalInvestment !== null && draft.exitValueEur !== null
      ? draft.exitValueEur - totalInvestment
      : null;
  const marginPct =
    marginEur !== null && totalInvestment !== null && totalInvestment > 0
      ? (marginEur / totalInvestment) * 100
      : null;
  const cashNeededEur =
    totalInvestment !== null && draft.financingEur !== null
      ? Math.max(0, totalInvestment - draft.financingEur)
      : null;
  const maximumEntryPriceEur =
    draft.exitValueEur !== null &&
    draft.acquisitionCostsEur !== null &&
    draft.worksEur !== null &&
    draft.carryingCostsEur !== null &&
    draft.targetProfitEur !== null
      ? draft.exitValueEur -
        draft.acquisitionCostsEur -
        draft.worksEur -
        draft.carryingCostsEur -
        draft.targetProfitEur
      : null;
  const headroomEur =
    maximumEntryPriceEur !== null && draft.priceEur !== null
      ? maximumEntryPriceEur - draft.priceEur
      : null;
  return {
    totalInvestment,
    marginEur,
    marginPct,
    cashNeededEur,
    maximumEntryPriceEur,
    headroomEur,
  };
}

export function pilotReadiness(definition: PilotDefinition, draft: PilotDraft) {
  const verified = definition.checks.filter(
    (check) => draft.checkStatuses[check.id] === "verified",
  ).length;
  const blocked = definition.checks.filter((check) => draft.checkStatuses[check.id] === "blocked");
  const missingFacts = definition.facts.filter((fact) => !fact.value);
  const remaining = definition.checks.length - verified - blocked.length;
  return { verified, blocked, remaining, missingFacts };
}

export function buildPilotPacket({
  definition,
  draft,
  saleTitle,
  saleUrl,
  documents = [],
}: {
  definition: PilotDefinition;
  draft: PilotDraft;
  saleTitle: string;
  saleUrl: string | null;
  documents?: Array<{ label: string; url: string }>;
}): string {
  const economics = pilotEconomics(draft);
  const euro = (amount: number | null) =>
    amount === null ? "À chiffrer" : `${Math.round(amount).toLocaleString("fr-FR")} €`;
  const checkLabel = {
    todo: "À vérifier",
    verified: "Vérifié par l'utilisateur",
    blocked: "Bloquant",
  };
  const lines = [
    `# ${definition.packetLabel} — ${saleTitle}`,
    "",
    `Dossier généré le ${new Date().toLocaleDateString("fr-FR")}. Les données publiées et les hypothèses de l'utilisateur doivent être vérifiées dans les pièces officielles.`,
    saleUrl ? `Annonce : ${saleUrl}` : "Annonce : lien indisponible",
    "",
    "## Hypothèses de l'investisseur",
    `- ${definition.priceLabel} : ${euro(draft.priceEur)}`,
    `- Frais d'acquisition : ${euro(draft.acquisitionCostsEur)}`,
    `- Travaux : ${euro(draft.worksEur)}`,
    `- Portage et autres frais : ${euro(draft.carryingCostsEur)}`,
    `- Valeur de sortie envisagée : ${euro(draft.exitValueEur)}`,
    `- Financement mobilisable : ${euro(draft.financingEur)}`,
    `- Profit cible : ${euro(draft.targetProfitEur)}`,
    `- Investissement total : ${euro(economics.totalInvestment)}`,
    `- Marge brute indicative : ${euro(economics.marginEur)}`,
    `- Fonds propres nécessaires : ${euro(economics.cashNeededEur)}`,
    `- Prix d'entrée maximum selon les hypothèses : ${economics.maximumEntryPriceEur !== null && economics.maximumEntryPriceEur < 0 ? "Objectif irréalisable avec les coûts saisis" : euro(economics.maximumEntryPriceEur)}`,
    "",
    "## Faits publiés et points à confirmer",
    ...definition.facts.map(
      (fact) =>
        `- ${fact.label} : ${fact.value ?? "À confirmer"}${fact.sourceUrl ? ` (${fact.sourceUrl})` : " (source du dossier à contrôler)"}`,
    ),
    "",
    "## Échéances",
    ...definition.milestones.map(
      (milestone) =>
        `- ${milestone.label} : ${milestone.date ?? "À confirmer"}${milestone.sourceUrl ? ` (${milestone.sourceUrl})` : ""}`,
    ),
    "",
    "## Vérifications",
    ...definition.checks.map(
      (check) =>
        `- [${draft.checkStatuses[check.id] === "verified" ? "x" : " "}] ${check.label} — ${checkLabel[draft.checkStatuses[check.id] ?? "todo"]}${check.sourceUrl ? ` (${check.sourceUrl})` : ""}`,
    ),
    "",
    "## Pièces du dossier",
    ...(documents.length
      ? documents.map((document) => {
          const status = draft.documentStatuses[document.url] ?? "todo";
          const label =
            status === "reviewed"
              ? "Relue par l'utilisateur"
              : status === "question"
                ? "Question ouverte"
                : "À relire";
          const note = draft.documentNotes[document.url]?.trim();
          return `- ${document.label} — ${label} (${document.url})${note ? ` — ${note}` : ""}`;
        })
      : ["Aucune pièce attachée à l'annonce."]),
    "",
    "## Questions ouvertes",
    draft.questions.trim() || "Aucune question renseignée.",
    "",
    "## Prochaine action",
    draft.nextAction.trim() || "À définir",
    draft.nextActionAt ? `Échéance personnelle : ${draft.nextActionAt}` : "",
  ];
  return lines.filter((line) => line !== undefined).join("\n");
}
