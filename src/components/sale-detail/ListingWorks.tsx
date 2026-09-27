import Wrench from "lucide-react/dist/esm/icons/wrench.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import { riskEvidence } from "@/lib/risk-evidence";
import { formatPrice } from "@/lib/format";
import type { AuctionSale, SaleRisk } from "@/lib/types";

function workRisks(sale: AuctionSale): SaleRisk[] {
  return (sale.risks ?? []).filter((risk) =>
    /work|travaux|rénov|renov/i.test(`${risk.risk_type} ${risk.risk_label}`),
  );
}

export function WorksSpotlight({ sale }: { sale: AuctionSale }) {
  const firstRisk = workRisks(sale)[0];
  if (!firstRisk) return null;
  const firstProof = riskEvidence(firstRisk).proofs[0];

  return (
    <aside className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-gold/30 bg-[#fffaf2] px-4 py-4 text-brand-navy sm:px-5">
      <Wrench className="h-5 w-5 shrink-0 text-gold-soft" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Travaux signalés dans le dossier</p>
        <p className="mt-0.5 text-sm leading-relaxed text-brand-navy/75">
          {firstProof.excerpt ?? firstRisk.risk_label}
        </p>
      </div>
      <a
        href="#works"
        className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-gold-soft underline underline-offset-4"
      >
        Examiner ce point <ArrowRight className="h-4 w-4" aria-hidden />
      </a>
    </aside>
  );
}

export function ListingWorks({
  sale,
  estimatedBudget,
}: {
  sale: AuctionSale;
  estimatedBudget: number | null;
}) {
  const risks = workRisks(sale);

  return (
    <section id="works" aria-labelledby="listing-works-title" className="scroll-mt-36 bg-white">
      <div className="mx-auto max-w-[1260px] px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-brand-navy/15 pb-5">
          <div>
            <h2
              id="listing-works-title"
              className="font-display text-4xl font-medium text-brand-navy sm:text-5xl"
            >
              Travaux et état du bien
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-brand-navy/70 sm:text-base">
              Les constats du dossier et le budget utilisé pour la simulation sont présentés
              séparément.
            </p>
          </div>
          {estimatedBudget != null ? (
            <div className="min-w-[12rem] rounded-lg bg-[#f4f6f9] px-5 py-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-navy/60">
                Enveloppe de simulation
              </p>
              <p className="mt-1 font-display text-3xl font-semibold text-brand-navy">
                {formatPrice(estimatedBudget)}
              </p>
            </div>
          ) : null}
        </div>

        {risks.length > 0 ? (
          <ul className="divide-y divide-brand-navy/12" aria-label="Points travaux du dossier">
            {risks.map((risk, index) => {
              const proof = riskEvidence(risk).proofs[0];
              return (
                <li
                  key={`${risk.risk_type}-${risk.risk_label}-${index}`}
                  className="grid gap-2 py-5 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)] sm:gap-8"
                >
                  <p className="font-semibold text-brand-navy">{risk.risk_label}</p>
                  <div className="text-sm leading-relaxed text-brand-navy/75">
                    {proof.excerpt ? <p>{proof.excerpt}</p> : null}
                    <p className={proof.excerpt ? "mt-2" : ""}>
                      {proof.url ? (
                        <a
                          href={proof.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-gold-soft underline underline-offset-4"
                        >
                          {proof.label} (nouvel onglet)
                        </a>
                      ) : (
                        proof.label
                      )}
                      {proof.page != null ? ` · page ${proof.page}` : ""}
                    </p>
                    <p className="mt-1 text-brand-navy/65">
                      À confirmer avant d’engager des travaux.
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-6 text-sm leading-relaxed text-brand-navy/75">
            Aucun constat de travaux documenté n’est disponible dans cette fiche. Faites vérifier
            l’état du bien et les pièces avant de retenir un budget.
          </p>
        )}
        {estimatedBudget != null ? (
          <p className="border-t border-brand-navy/12 pt-4 text-sm leading-relaxed text-brand-navy/65">
            Cette enveloppe est une hypothèse ajustable dans le calcul de mise plafond ; elle ne
            remplace pas un devis établi après visite.
          </p>
        ) : null}
      </div>
    </section>
  );
}
