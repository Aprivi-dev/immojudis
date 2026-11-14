import { SaleDetailLink } from "@/components/SaleDetailLink";
import { Badge } from "@/components/ui/primitives";
import {
  departmentFromCode,
  departmentPriceLabel,
  departmentSaleTimeText,
  departmentVenueLabel,
  groupDepartmentSalesByWeek,
  identicalSaleRanks,
  isParisToday,
  parisDateBlock,
  type DepartmentSale,
} from "@/lib/department-pages";
import { formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import { saleHearingTime, seoSurface } from "@/lib/seo";
import { cn } from "@/lib/utils";

/**
 * Une vente à venir d'une liste publique. `department` n'est porté que par une liste qui couvre
 * plusieurs départements (pages par type de vente ou de bien) ; la page d'un département ne le
 * porte pas (c'est le sien). Son affichage dépend de `showDepartment`, pas de sa présence.
 */
export type ListedSale = DepartmentSale & { department?: string | null };

function positivePrice(value: number | null): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

/**
 * Une ligne de « Les prochaines ventes » : pavé de date, commune, détails, type de vente, prix. Le
 * lien garde la page d'origine de la fiche (« Retour aux ventes du département »), ajoutée dans le
 * navigateur seulement et seulement pour une origine reconnue (`safeSalesReturnTo`) : le HTML reste
 * `/sales/<id>`.
 */
function SaleRow({
  sale,
  identical,
  now,
  returnTo,
  showDepartment,
}: {
  sale: ListedSale;
  identical: { rank: number; of: number } | undefined;
  now: Date;
  returnTo: string;
  showDepartment: boolean;
}) {
  const postponed = sale.status === "postponed";
  const block = postponed ? null : parisDateBlock(sale.saleDate);
  const today = !postponed && isParisToday(sale.saleDate, now);
  const venue = departmentVenueLabel(sale.venueType);
  const departmentCode =
    showDepartment && sale.department ? departmentFromCode(sale.department)?.code : null;
  const place = sale.city || "Commune à confirmer";
  const details = [
    propertyTypeLabel(sale.propertyType),
    seoSurface(sale.surfaceM2),
    departmentSaleTimeText(sale, saleHearingTime(sale.saleDate), now),
    identical ? `annonce ${identical.rank} sur ${identical.of} de même description` : null,
  ].filter(Boolean);
  return (
    <li>
      <SaleDetailLink
        saleId={sale.id.toLowerCase()}
        returnTo={returnTo}
        className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 px-3.5 py-3 hover:bg-surface-muted sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:px-[1.125rem] sm:py-3.5"
      >
        <span
          className={cn(
            "flex size-14 flex-col items-center justify-center rounded-lg leading-tight sm:size-16",
            today ? "bg-brand-navy text-white" : "bg-surface-tint",
          )}
        >
          {block ? (
            <>
              <span className="text-[1.375rem] font-bold tabular-nums">{block.day}</span>
              <span
                className={cn(
                  "text-xs font-semibold tracking-[0.06em] uppercase",
                  today ? "text-gold-light" : "text-ink-strong",
                )}
              >
                {block.month}
              </span>
            </>
          ) : (
            <span aria-hidden className="text-[1.375rem] font-bold text-ink-soft">
              –
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block font-semibold">
            {departmentCode ? `${place} (${departmentCode})` : place}
          </span>
          <span className="mt-0.5 block text-sm text-ink-soft">{details.join(" · ")}</span>
          {venue || today ? (
            <span className="mt-2 flex flex-wrap gap-1.5">
              {venue ? <Badge>{venue}</Badge> : null}
              {today ? <Badge tone="danger">Aujourd’hui</Badge> : null}
            </span>
          ) : null}
        </span>
        <span className="col-start-2 flex flex-wrap items-baseline gap-x-1.5 sm:col-start-auto sm:block sm:text-right">
          <span className="text-xs text-ink-soft sm:block">{departmentPriceLabel(sale)}</span>
          {positivePrice(sale.startingPriceEur) ? (
            <span className="text-lg font-semibold whitespace-nowrap text-brand-navy tabular-nums sm:block">
              {formatStartingPrice(sale.startingPriceEur)}
            </span>
          ) : (
            <span className="text-sm font-semibold text-ink-soft sm:block">Non communiqué</span>
          )}
        </span>
      </SaleDetailLink>
    </li>
  );
}

/**
 * « Les prochaines ventes », groupées par semaine (`groupDepartmentSalesByWeek`) : pages de
 * département et pages par type de vente ou de bien. Les ventes arrivent déjà triées par date.
 */
export function UpcomingSaleWeeks({
  sales,
  now,
  returnTo,
  showDepartment = false,
}: {
  sales: readonly ListedSale[];
  now: Date;
  /** Adresse de la page qui liste les ventes (origine du lien « Retour » de la fiche). */
  returnTo: string;
  /**
   * Écrit le numéro du département à côté de la commune : pour une liste qui couvre plusieurs
   * départements (pages par type de vente ou de bien), pas pour la page d'un département.
   */
  showDepartment?: boolean;
}) {
  const identicalSales = identicalSaleRanks(sales);
  return groupDepartmentSalesByWeek(sales, now).map((week) => (
    <div key={week.key} className="mt-5">
      <h3 className="mb-2 text-caption font-bold tracking-[0.12em] text-gold-text uppercase">
        {week.label}
      </h3>
      <ul className="divide-y divide-line-soft rounded-lg border border-line-soft bg-white">
        {week.sales.map((sale) => (
          <SaleRow
            key={sale.id}
            sale={sale}
            identical={identicalSales.get(sale.id)}
            now={now}
            returnTo={returnTo}
            showDepartment={showDepartment}
          />
        ))}
      </ul>
    </div>
  ));
}
