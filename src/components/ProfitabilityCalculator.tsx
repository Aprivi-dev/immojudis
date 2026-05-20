import { useEffect, useMemo, useState } from "react";
import { Calculator, ChevronDown, ChevronUp, Info, RotateCcw } from "lucide-react";
import { computeProfitability, DEFAULTS, yieldVerdict } from "@/lib/profitability";
import { defaultRentPerM2 } from "@/lib/geo";
import { formatPrice } from "@/lib/format";
import type { AuctionSale } from "@/lib/types";

type StoredState = {
  price: number;
  works: number;
  rentPerM2: number;
  fpt: number;
  vacancyPct: number;
  chargesPct: number;
  propertyTaxMonths: number;
  managementPct: number;
  rentEdited: boolean;
};

function storageKey(saleId: string) {
  return `profitability:${saleId}`;
}

function loadState(saleId: string): Partial<StoredState> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(saleId));
    if (!raw) return null;
    return JSON.parse(raw) as Partial<StoredState>;
  } catch {
    return null;
  }
}

function fmt(n: number): string {
  return formatPrice(Math.round(n));
}

function pct(n: number): string {
  return `${n.toFixed(2)} %`;
}

export function ProfitabilityCalculator({ sale }: { sale: AuctionSale }) {
  const surface = sale.app_surface_m2 ?? sale.habitable_surface_m2 ?? sale.carrez_surface_m2 ?? null;
  const dept = sale.department ?? null;
  const startingPrice = sale.starting_price_eur ?? 0;
  const defaultRent = defaultRentPerM2(dept);

  const [expert, setExpert] = useState(false);
  const [state, setState] = useState<StoredState>(() => ({
    price: startingPrice,
    works: 0,
    rentPerM2: defaultRent,
    fpt: DEFAULTS.fpt,
    vacancyPct: DEFAULTS.vacancyPct,
    chargesPct: DEFAULTS.chargesPct,
    propertyTaxMonths: DEFAULTS.propertyTaxMonths,
    managementPct: DEFAULTS.managementPct,
    rentEdited: false,
  }));

  // Charger l'état persistant côté client uniquement (évite tout mismatch SSR)
  useEffect(() => {
    const stored = loadState(sale.id);
    if (stored) setState((s) => ({ ...s, ...stored }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale.id]);

  // Persister
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey(sale.id), JSON.stringify(state));
    } catch {
      /* ignore quota errors */
    }
  }, [sale.id, state]);

  const result = useMemo(
    () =>
      computeProfitability({
        price: state.price,
        surface,
        department: dept,
        rentPerM2: state.rentEdited ? state.rentPerM2 : undefined,
        works: state.works,
        fpt: state.fpt,
        vacancyPct: state.vacancyPct,
        chargesPct: state.chargesPct,
        propertyTaxMonths: state.propertyTaxMonths,
        managementPct: state.managementPct,
      }),
    [state, surface, dept],
  );

  const reset = () => {
    if (typeof window !== "undefined") window.localStorage.removeItem(storageKey(sale.id));
    setState({
      price: startingPrice,
      works: 0,
      rentPerM2: defaultRent,
      fpt: DEFAULTS.fpt,
      vacancyPct: DEFAULTS.vacancyPct,
      chargesPct: DEFAULTS.chargesPct,
      propertyTaxMonths: DEFAULTS.propertyTaxMonths,
      managementPct: DEFAULTS.managementPct,
      rentEdited: false,
    });
  };

  if (!surface || surface <= 0) {
    return (
      <section className="rounded-lg border border-border bg-card p-5">
        <Header />
        <p className="mt-3 text-sm text-muted-foreground">
          Calcul indisponible : la surface du bien n'est pas renseignée.
        </p>
      </section>
    );
  }

  const verdict = yieldVerdict(result.netYieldPct);
  const verdictTone: Record<typeof verdict.tone, string> = {
    good: "bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-200 dark:border-emerald-900/40",
    ok: "bg-blue-50 text-blue-900 border-blue-200 dark:bg-blue-900/20 dark:text-blue-200 dark:border-blue-900/40",
    warn: "bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-900/20 dark:text-amber-200 dark:border-amber-900/40",
    bad: "bg-red-50 text-red-900 border-red-200 dark:bg-red-900/20 dark:text-red-200 dark:border-red-900/40",
  };

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <Header onReset={reset} />

      {/* Inputs essentiels */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field
          label="Prix d'adjudication"
          suffix="€"
          value={state.price}
          onChange={(v) => setState((s) => ({ ...s, price: v }))}
          hint={`Mise à prix : ${formatPrice(startingPrice)}`}
        />
        <Field
          label="Loyer estimé"
          suffix="€/m²/mois"
          step={0.5}
          value={state.rentPerM2}
          onChange={(v) => setState((s) => ({ ...s, rentPerM2: v, rentEdited: true }))}
          hint={state.rentEdited ? `Défaut dépt. : ${defaultRent} €/m²` : `Estimé pour le dépt. ${dept ?? "—"}`}
        />
        <Field
          label="Travaux"
          suffix="€"
          value={state.works}
          onChange={(v) => setState((s) => ({ ...s, works: v }))}
          hint="Estimation des rénovations"
        />
      </div>

      {/* Verdict */}
      <div className={`mt-4 rounded-md border p-4 ${verdictTone[verdict.tone]}`}>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide opacity-80">Rendement net</div>
            <div className="mt-1 text-3xl font-bold tabular-nums">{pct(result.netYieldPct)}</div>
            <div className="mt-1 text-sm font-medium">{verdict.label}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide opacity-80">Coût de revient</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{fmt(result.totalCost)}</div>
            <div className="mt-0.5 text-xs opacity-80">Brut : {pct(result.grossYieldPct)}</div>
          </div>
        </div>
      </div>

      {/* Décomposition synthétique toujours visible */}
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <Cell label="Loyer mensuel" value={fmt(result.monthlyRent)} />
        <Cell label="Loyer annuel" value={fmt(result.annualRent)} />
        <Cell label="Frais d'enchères" value={`${fmt(result.acquisitionFeesTotal)} (${result.acquisitionFeesPct.toFixed(1)} %)`} />
        <Cell label="Revenu net annuel" value={fmt(result.netAnnualIncome)} />
      </dl>

      {/* Mode expert */}
      <button
        type="button"
        onClick={() => setExpert((e) => !e)}
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        {expert ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        {expert ? "Masquer le détail" : "Mode expert (détail des frais et charges)"}
      </button>

      {expert && (
        <div className="mt-3 space-y-4">
          {/* Détail des frais d'acquisition */}
          <div className="rounded-md border border-border bg-background p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Détail des frais d'acquisition
            </div>
            <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              <Row label="Émoluments avocat (HT)" value={fmt(result.emolumentsHT)} />
              <Row label="TVA sur émoluments" value={fmt(result.emolumentsTTC - result.emolumentsHT)} />
              <Row label="Droits d'enregistrement (5,80 %)" value={fmt(result.registrationDuties)} />
              <Row label="Frais préalables taxés (FPT)" value={fmt(result.fpt)} editable
                onEdit={(v) => setState((s) => ({ ...s, fpt: v }))} current={state.fpt} />
              <Row label="Travaux" value={fmt(result.works)} />
              <Row label="Total des frais" value={fmt(result.acquisitionFeesTotal)} bold />
            </dl>
          </div>

          {/* Paramètres locatifs */}
          <div className="rounded-md border border-border bg-background p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Paramètres locatifs
            </div>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field
                label="Vacance locative"
                suffix="%"
                value={state.vacancyPct}
                onChange={(v) => setState((s) => ({ ...s, vacancyPct: v }))}
              />
              <Field
                label="Charges non récupérables"
                suffix="% du loyer"
                value={state.chargesPct}
                onChange={(v) => setState((s) => ({ ...s, chargesPct: v }))}
              />
              <Field
                label="Taxe foncière"
                suffix="mois de loyer"
                step={0.5}
                value={state.propertyTaxMonths}
                onChange={(v) => setState((s) => ({ ...s, propertyTaxMonths: v }))}
              />
              <Field
                label="Gestion locative"
                suffix="%"
                value={state.managementPct}
                onChange={(v) => setState((s) => ({ ...s, managementPct: v }))}
              />
            </div>
          </div>

          {/* Détail revenus */}
          <div className="rounded-md border border-border bg-background p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Décomposition annuelle
            </div>
            <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
              <Row label="Loyer annuel brut" value={fmt(result.annualRent)} />
              <Row label="− Vacance locative" value={`-${fmt(result.vacancyLoss)}`} />
              <Row label="− Charges non récup." value={`-${fmt(result.charges)}`} />
              <Row label="− Taxe foncière" value={`-${fmt(result.propertyTax)}`} />
              <Row label="− Gestion" value={`-${fmt(result.management)}`} />
              <Row label="= Revenu net annuel" value={fmt(result.netAnnualIncome)} bold />
            </dl>
          </div>
        </div>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Estimations indicatives. Les frais sont calculés selon le barème officiel (art. A444-191 CdC) mais ne remplacent pas le décompte du cahier des conditions de vente. {result.isRentEstimated && "Le loyer est une estimation médiane par département."}
      </p>
    </section>
  );
}

function Header({ onReset }: { onReset?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Calculator className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Calculateur de rentabilité</h2>
      </div>
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="Réinitialiser"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Réinitialiser
        </button>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  hint,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  hint?: string;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1 flex items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
        <input
          type="number"
          inputMode="decimal"
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full bg-transparent px-3 py-1.5 text-sm tabular-nums outline-none"
        />
        {suffix && <span className="pr-3 text-xs text-muted-foreground">{suffix}</span>}
      </div>
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  editable,
  current,
  onEdit,
}: {
  label: string;
  value: string;
  bold?: boolean;
  editable?: boolean;
  current?: number;
  onEdit?: (v: number) => void;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 ${bold ? "border-t border-border pt-1.5 font-semibold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      {editable && onEdit ? (
        <input
          type="number"
          value={current ?? 0}
          onChange={(e) => onEdit(parseFloat(e.target.value) || 0)}
          className="w-24 rounded border border-input bg-background px-2 py-0.5 text-right text-sm tabular-nums"
        />
      ) : (
        <span className="tabular-nums text-foreground">{value}</span>
      )}
    </div>
  );
}