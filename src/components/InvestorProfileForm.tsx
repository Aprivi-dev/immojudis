"use client";

import { useId, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/primitives";
import { useInvestorProfile } from "@/hooks/use-investor-profile";
import { deleteInvestorProfile, saveInvestorProfile } from "@/lib/client-api";
import {
  INVESTOR_DOWN_PAYMENT_MAX_EUR,
  INVESTOR_MARGIN_MAX_PCT,
  INVESTOR_STRATEGIES,
  INVESTOR_STRATEGY_LABELS,
  INVESTOR_WORKS_PER_M2_MAX_EUR,
  investorProfileIsEmpty,
  parseProfileNumber,
  type InvestorProfile,
  type InvestorStrategy,
} from "@/lib/investor-profile";
import * as queryKeys from "@/lib/query-keys";
import { toast } from "@/lib/toast";
import { userMessage } from "@/lib/user-messages";

const NUMBER_FORMAT = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });

function fieldText(value: number | null | undefined): string {
  return value == null ? "" : NUMBER_FORMAT.format(value);
}

/**
 * « Mon profil d'investisseur » (`/compte`, n° 93) : apport, marge cible, budget travaux au mètre
 * carré et stratégie, enregistrés une fois sur le compte. Ils préremplissent le calcul de l'enchère
 * plafond de chaque vente, que la personne modifie ensuite vente par vente. Donnée financière
 * personnelle : visible de son propriétaire seul, jamais envoyée par email, effaçable à tout moment.
 */
export function InvestorProfileForm({ userId }: { userId: string }) {
  const { profile, loading } = useInvestorProfile(userId);
  if (loading) {
    return (
      <p role="status" className="mt-3 text-sm text-muted-foreground">
        Chargement de votre profil…
      </p>
    );
  }
  // Le formulaire repart des valeurs enregistrées chaque fois que le profil change (après
  // l'enregistrement ou l'effacement) : la clé en porte le contenu.
  return <ProfileFields key={JSON.stringify(profile)} userId={userId} profile={profile} />;
}

function ProfileFields({ userId, profile }: { userId: string; profile: InvestorProfile | null }) {
  const queryClient = useQueryClient();
  const ids = { strategy: useId(), down: useId(), margin: useId(), works: useId() };
  const errorId = useId();
  const [strategy, setStrategy] = useState<InvestorStrategy | "">(profile?.strategy ?? "");
  const [down, setDown] = useState(fieldText(profile?.downPaymentEur));
  const [margin, setMargin] = useState(fieldText(profile?.targetMarginPct));
  const [works, setWorks] = useState(fieldText(profile?.worksPerM2Eur));
  const [error, setError] = useState<string | null>(null);
  const key = queryKeys.investorProfile(userId);

  const save = useMutation({
    mutationFn: (data: Parameters<typeof saveInvestorProfile>[0]["data"]) =>
      saveInvestorProfile({ data }),
    onSuccess: (response) => {
      queryClient.setQueryData(key, response);
      toast.success("Votre profil est enregistré.");
    },
    onError: (failure: unknown) =>
      toast.error(userMessage(failure, "Impossible d’enregistrer votre profil.")),
  });
  const remove = useMutation({
    mutationFn: () => deleteInvestorProfile(),
    onSuccess: () => {
      queryClient.setQueryData(key, { profile: null });
      toast.success("Votre profil est effacé.");
    },
    onError: (failure: unknown) =>
      toast.error(userMessage(failure, "Impossible d’effacer votre profil.")),
  });
  const busy = save.isPending || remove.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const downPayment = parseProfileNumber(down, {
      max: INVESTOR_DOWN_PAYMENT_MAX_EUR,
      label: "Apport",
      decimals: false,
    });
    const targetMargin = parseProfileNumber(margin, {
      max: INVESTOR_MARGIN_MAX_PCT,
      label: "Marge cible",
      decimals: true,
    });
    const worksPerM2 = parseProfileNumber(works, {
      max: INVESTOR_WORKS_PER_M2_MAX_EUR,
      label: "Travaux au m²",
      decimals: false,
    });
    for (const result of [downPayment, targetMargin, worksPerM2]) {
      if (!result.ok) {
        setError(result.message);
        return;
      }
    }
    const input = {
      downPaymentEur: downPayment.ok ? downPayment.value : null,
      targetMarginPct: targetMargin.ok ? targetMargin.value : null,
      worksPerM2Eur: worksPerM2.ok ? worksPerM2.value : null,
      strategy: strategy || null,
    };
    if (
      input.downPaymentEur == null &&
      input.targetMarginPct == null &&
      input.worksPerM2Eur == null &&
      input.strategy == null
    ) {
      setError("Renseignez au moins une hypothèse, ou effacez votre profil.");
      return;
    }
    setError(null);
    save.mutate(input);
  }

  return (
    <form onSubmit={submit} noValidate className="mt-4 grid gap-4 sm:grid-cols-2" aria-busy={busy}>
      <div>
        <label htmlFor={ids.strategy} className="text-sm font-semibold text-foreground">
          Stratégie
        </label>
        <select
          id={ids.strategy}
          className="form-input mt-1 min-h-11 w-full"
          value={strategy}
          onChange={(event) => setStrategy(event.target.value as InvestorStrategy | "")}
        >
          <option value="">Non précisée</option>
          {INVESTOR_STRATEGIES.map((item) => (
            <option key={item} value={item}>
              {INVESTOR_STRATEGY_LABELS[item]}
            </option>
          ))}
        </select>
      </div>
      <NumberField
        id={ids.down}
        label="Apport personnel"
        unit="€"
        placeholder="Ex. 40 000"
        value={down}
        onChange={setDown}
        describedBy={error ? errorId : undefined}
      />
      <NumberField
        id={ids.margin}
        label="Marge cible"
        unit="%"
        placeholder="Ex. 15"
        value={margin}
        onChange={setMargin}
        describedBy={error ? errorId : undefined}
      />
      <NumberField
        id={ids.works}
        label="Travaux au m²"
        unit="€/m²"
        placeholder="Ex. 800"
        value={works}
        onChange={setWorks}
        describedBy={error ? errorId : undefined}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-semibold text-red-700 sm:col-span-2">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={busy}>
          {save.isPending ? "Enregistrement…" : "Enregistrer mon profil"}
        </Button>
        {!investorProfileIsEmpty(profile) ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  "Effacer votre profil d’investisseur ? Les calculs de plafond repartiront de leurs hypothèses de départ.",
                )
              ) {
                remove.mutate();
              }
            }}
          >
            Effacer mon profil
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function NumberField({
  id,
  label,
  unit,
  placeholder,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  label: string;
  unit: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  describedBy?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-semibold text-foreground">
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={describedBy}
          className="form-input min-h-11 w-full min-w-0 tabular-nums"
        />
        <span aria-hidden className="shrink-0 text-sm text-muted-foreground">
          {unit}
        </span>
      </div>
    </div>
  );
}
