import { useMemo, useState } from "react";
import Calculator from "lucide-react/dist/esm/icons/calculator.js";
import type { Property } from "@/lib/property-types";
import { formatCurrency } from "@/lib/format";
import { AnimatedSection } from "./AnimatedSection";

export function MortgageCalculator({ property }: { property: Property }) {
  const [downPayment, setDownPayment] = useState(Math.round(property.price * 0.2));
  const [rate, setRate] = useState(3.8);
  const [years, setYears] = useState(20);

  const monthlyPayment = useMemo(() => {
    const principal = Math.max(property.price - downPayment, 0);
    const monthlyRate = rate / 100 / 12;
    const payments = years * 12;
    if (!principal || !payments) return 0;
    if (!monthlyRate) return principal / payments;
    return (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -payments));
  }, [downPayment, property.price, rate, years]);

  return (
    <AnimatedSection id="mortgage" aria-labelledby="mortgage-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Financement
        </p>
        <h2 id="mortgage-title" className="mt-2 font-display text-3xl text-foreground">
          Calculateur de mensualite
        </h2>
      </div>
      <div className="mt-5 grid gap-5 rounded-md border border-border bg-white p-5 md:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid gap-4">
          <label className="grid gap-2 text-sm font-semibold text-foreground">
            Apport
            <input
              type="number"
              min={0}
              max={property.price}
              value={downPayment}
              onChange={(event) => setDownPayment(Number(event.target.value))}
              className="h-11 rounded-md border border-border bg-white px-3 outline-none transition-colors focus:border-gold"
            />
          </label>
          <label className="grid gap-2 text-sm font-semibold text-foreground">
            Taux annuel
            <input
              type="range"
              min={0}
              max={8}
              step={0.1}
              value={rate}
              onChange={(event) => setRate(Number(event.target.value))}
              className="accent-[var(--gold)]"
            />
            <span className="text-sm text-muted-foreground">{rate.toFixed(1)}%</span>
          </label>
          <label className="grid gap-2 text-sm font-semibold text-foreground">
            Duree
            <select
              value={years}
              onChange={(event) => setYears(Number(event.target.value))}
              className="h-11 rounded-md border border-border bg-white px-3 outline-none transition-colors focus:border-gold"
            >
              {[10, 15, 20, 25].map((value) => (
                <option key={value} value={value}>
                  {value} ans
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="rounded-md bg-muted/40 p-5">
          <Calculator className="h-5 w-5 text-gold-soft" />
          <div className="mt-4 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Mensualite estimee
          </div>
          <div className="mt-2 text-3xl font-semibold text-foreground">
            {formatCurrency(Math.round(monthlyPayment), property.currency)}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            Estimation hors assurance, frais et conditions bancaires.
          </p>
        </div>
      </div>
    </AnimatedSection>
  );
}
