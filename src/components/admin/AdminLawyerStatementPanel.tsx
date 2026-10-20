import { useQuery } from "@tanstack/react-query";
import Download from "lucide-react/dist/esm/icons/download.js";
import FileSpreadsheet from "lucide-react/dist/esm/icons/file-spreadsheet.js";
import { useState } from "react";
import { formatInteger, queryErrorMessage } from "@/components/admin/admin-format";
import { fetchAdminLawyerStatement } from "@/lib/client-api/admin";
import {
  buildLawyerStatementCsv,
  lawyerStatementCsvFilename,
  lawyerStatementMonthLabel,
  lawyerStatementMonthSchema,
  previousLawyerStatementMonth,
} from "@/lib/lawyer-statement";

export const LAWYER_STATEMENT_QUERY_KEY = "admin-lawyer-statement";

/** Télécharge le CSV (BOM UTF-8 pour l'ouverture directe dans un tableur en français). */
function downloadCsv(filename: string, content: string) {
  const bom = String.fromCharCode(0xfeff);
  const url = URL.createObjectURL(new Blob([bom, content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Relevé mensuel des avocats référencés (point 72) : affichages, clics et demandes transmises de
 * chaque avocat sur le mois choisi, à exporter en CSV et à envoyer à la main. Rien n'est envoyé d'ici,
 * et le relevé ne contient que des nombres (aucune donnée d'acquéreur ni de compte).
 */
export function AdminLawyerStatementPanel() {
  const [month, setMonth] = useState(() => previousLawyerStatementMonth());
  const monthIsValid = lawyerStatementMonthSchema.safeParse(month).success;
  const query = useQuery({
    queryKey: [LAWYER_STATEMENT_QUERY_KEY, month],
    queryFn: () => fetchAdminLawyerStatement(month),
    enabled: monthIsValid,
    staleTime: 60_000,
  });
  const statement = query.data;
  const canExport = Boolean(statement && statement.month === month && statement.rows.length);

  return (
    <section className="admin-panel mt-6 rounded-lg p-5" aria-labelledby="lawyer-statement-title">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-gold-text">
            <FileSpreadsheet className="h-4 w-4" aria-hidden />
            Relevé mensuel
          </div>
          <h2 id="lawyer-statement-title" className="mt-3 font-display text-2xl">
            Relevé des avocats référencés
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-brand-navy/70">
            Des nombres par avocat, sans aucune donnée d’acquéreur ni de compte. Exportez le CSV et
            envoyez-le vous-même : rien n’est envoyé automatiquement.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Mois
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              pattern="\d{4}-\d{2}"
              placeholder="AAAA-MM"
              aria-invalid={!monthIsValid}
              className="min-h-11 rounded-lg border border-brand-navy/10 bg-white px-3 py-2.5 text-sm normal-case tracking-normal text-foreground outline-none transition focus:border-gold"
            />
          </label>
          <button
            type="button"
            className="admin-button-secondary inline-flex min-h-11 items-center gap-2"
            disabled={!canExport}
            onClick={() => {
              if (!statement) return;
              downloadCsv(
                lawyerStatementCsvFilename(statement.month),
                buildLawyerStatementCsv(statement),
              );
            }}
          >
            <Download className="h-4 w-4" aria-hidden />
            Exporter en CSV
          </button>
        </div>
      </div>

      {!monthIsValid ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          Choisissez un mois au format AAAA-MM.
        </p>
      ) : null}
      {monthIsValid && query.isError ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-red-300/20 bg-danger-tint p-3 text-sm text-danger"
        >
          {queryErrorMessage(query.error, "Relevé indisponible")}
          <button
            type="button"
            className="admin-button-secondary mt-3 block"
            onClick={() => void query.refetch()}
          >
            Réessayer
          </button>
        </div>
      ) : null}
      {monthIsValid && query.isPending ? (
        <p role="status" className="mt-4 text-sm text-brand-navy/60">
          Chargement du relevé…
        </p>
      ) : null}

      {monthIsValid && statement ? (
        <div className="mt-5">
          <p className="text-sm font-medium text-brand-navy">
            {lawyerStatementMonthLabel(statement.month)} (mois civil, heure de Paris)
          </p>
          {statement.rows.length ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[30rem] text-left text-sm">
                <caption className="sr-only">
                  Relevé de {lawyerStatementMonthLabel(statement.month)} par avocat référencé
                </caption>
                <thead>
                  <tr className="border-b border-brand-navy/12 text-xs uppercase tracking-[0.08em] text-brand-navy/62">
                    <th scope="col" className="py-2 pr-4 font-semibold">
                      Avocat
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      Affichages
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      Clics
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-semibold">
                      Demandes transmises
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {statement.rows.map((row) => (
                    <tr key={row.lawyerId} className="border-b border-brand-navy/8">
                      <th scope="row" className="py-2 pr-4 font-medium">
                        {row.displayName}
                        {row.firmName ? (
                          <span className="block text-xs font-normal text-brand-navy/60">
                            {row.firmName}
                          </span>
                        ) : null}
                      </th>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatInteger(row.impressions)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatInteger(row.ctaClicks)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatInteger(row.referralRequestsSent)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <th scope="row" className="py-2 pr-4">
                      Total
                    </th>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatInteger(statement.totals.impressions)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatInteger(statement.totals.ctaClicks)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatInteger(statement.totals.referralRequestsSent)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-sm text-brand-navy/65">
              Aucun avocat actif ni activité ce mois-ci.
            </p>
          )}
          <ul className="mt-4 list-disc space-y-1 pl-5 text-xs leading-relaxed text-brand-navy/62">
            <li>
              Affichages et clics : au plus un par compte connecté, par emplacement et par jour (pas
              de pages vues brutes).
            </li>
            <li>
              Demandes transmises : demandes de mise en relation envoyées à l’avocat pendant le
              mois, quelle que soit leur date de réception.
            </li>
          </ul>
        </div>
      ) : null}
    </section>
  );
}
