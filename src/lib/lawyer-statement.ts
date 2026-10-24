import { z } from "zod";

/**
 * Relevé mensuel des avocats référencés (point 72) : pour un mois civil (heure de Paris), le nombre
 * d'affichages et de clics de la mise en avant et de demandes de mise en relation transmises à
 * chaque avocat. Le propriétaire l'envoie à la main : rien n'est envoyé automatiquement.
 *
 * Uniquement des nombres et le nom professionnel de l'avocat : aucune donnée d'acquéreur ni de
 * compte. Ce module n'importe rien de serveur : le navigateur s'en sert pour valider le mois et
 * construire le CSV à partir des lignes déjà reçues.
 */

/** Mois demandé, au format `AAAA-MM`. */
export const lawyerStatementMonthSchema = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "Le mois du relevé doit être au format AAAA-MM.");

type LawyerStatementRow = {
  lawyerId: string;
  displayName: string;
  firmName: string | null;
  /** Affichages enregistrés (un par compte connecté, par emplacement et par jour). */
  impressions: number;
  /** Clics sur le bouton de la mise en avant (même règle). */
  ctaClicks: number;
  /** Demandes de mise en relation transmises à l'avocat pendant le mois. */
  referralRequestsSent: number;
};

export type LawyerStatement = {
  /** Mois civil du relevé, `AAAA-MM`. */
  month: string;
  rows: LawyerStatementRow[];
  totals: { impressions: number; ctaClicks: number; referralRequestsSent: number };
};

const count = z.coerce.number().int().nonnegative();
const statementRowSchema = z.object({
  lawyer_id: z.string().guid(),
  display_name: z.string(),
  firm_name: z.string().nullish(),
  impressions: count,
  cta_clicks: count,
  referral_requests_sent: count,
});

/** Lit les lignes de `admin_lawyer_monthly_statement` ; toute ligne hors contrat est refusée. */
export function parseLawyerStatement(month: string, raw: unknown): LawyerStatement {
  const rows = z
    .array(statementRowSchema)
    .parse(raw ?? [])
    .map(
      (row): LawyerStatementRow => ({
        lawyerId: row.lawyer_id,
        displayName: row.display_name,
        firmName: row.firm_name ?? null,
        impressions: row.impressions,
        ctaClicks: row.cta_clicks,
        referralRequestsSent: row.referral_requests_sent,
      }),
    );
  return {
    month,
    rows,
    totals: {
      impressions: rows.reduce((sum, row) => sum + row.impressions, 0),
      ctaClicks: rows.reduce((sum, row) => sum + row.ctaClicks, 0),
      referralRequestsSent: rows.reduce((sum, row) => sum + row.referralRequestsSent, 0),
    },
  };
}

/** Premier jour du mois du relevé, au format `AAAA-MM-01` attendu par la fonction SQL. */
export function lawyerStatementMonthStart(month: string): string {
  return `${lawyerStatementMonthSchema.parse(month)}-01`;
}

/** Mois précédent la date donnée, en heure de Paris : celui qu'on envoie d'ordinaire au début du suivant. */
export function previousLawyerStatementMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${previous.year}-${String(previous.month).padStart(2, "0")}`;
}

/** « novembre 2026 » pour `2026-11`. */
export function lawyerStatementMonthLabel(month: string): string {
  const [year, monthNumber] = lawyerStatementMonthSchema.parse(month).split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

const LAWYER_STATEMENT_CSV_HEADERS = [
  "mois",
  "avocat",
  "cabinet",
  "affichages",
  "clics",
  "demandes_transmises",
] as const;

/** Cellule CSV : retours à la ligne retirés, formule de tableur neutralisée, guillemets doublés. */
function csvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  const normalized = String(value).replace(/\r?\n/g, " ").trim();
  const text =
    typeof value === "string" && /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
  if (!/[",;\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * CSV du relevé, séparateur « ; » (ouverture directe dans un tableur en français) et fins de ligne
 * CRLF. Une ligne par avocat puis une ligne « Total ». Le BOM UTF-8 est ajouté au téléchargement.
 */
export function buildLawyerStatementCsv(statement: LawyerStatement): string {
  const lines = statement.rows.map((row) => [
    statement.month,
    row.displayName,
    row.firmName,
    row.impressions,
    row.ctaClicks,
    row.referralRequestsSent,
  ]);
  lines.push([
    statement.month,
    "Total",
    null,
    statement.totals.impressions,
    statement.totals.ctaClicks,
    statement.totals.referralRequestsSent,
  ]);
  return [LAWYER_STATEMENT_CSV_HEADERS as readonly string[], ...lines]
    .map((line) => line.map(csvCell).join(";"))
    .join("\r\n");
}

export function lawyerStatementCsvFilename(month: string): string {
  return `immojudis-releve-avocats-${lawyerStatementMonthSchema.parse(month)}.csv`;
}
