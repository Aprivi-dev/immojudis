"use client";

import { useState, type FormEvent } from "react";
import { toast } from "@/lib/toast";
import { updateOfferOpeningSurvey } from "@/lib/client-billing";
import {
  OFFER_OPENING_INTERVIEW_HELP,
  OFFER_OPENING_INTERVIEW_TEXT,
  OFFER_OPENING_SURVEY_INTRO,
  OFFER_OPENING_SURVEY_PROFILES,
  type OfferOpeningSurveyProfile,
} from "@/lib/offer-opening-consent";
import type { OfferOpeningSurveyState } from "@/lib/offer-opening-notification";
import { userMessage } from "@/lib/user-messages";

/** « 12 » -> 12 ; champ vide ou illisible -> null (la question reste sans réponse). */
function parseCount(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed.replace(",", "."));
  return Number.isFinite(number) ? Math.round(number) : null;
}

/**
 * Liste d'attente qualifiée : trois questions facultatives (profil, ventes étudiées par mois, deux
 * repères de prix) et la case « J'accepte un entretien de 20 minutes », non cochée par défaut. À
 * montrer seulement une fois la demande d'information enregistrée : rien ici ne conditionne
 * l'inscription à la liste, et chaque champ peut rester vide.
 */
export function OfferOpeningSurvey({
  initial,
  className = "mt-3",
}: {
  initial: OfferOpeningSurveyState | null;
  className?: string;
}) {
  const [profile, setProfile] = useState<OfferOpeningSurveyProfile | "">(initial?.profile ?? "");
  const [sales, setSales] = useState(initial?.salesPerMonth?.toString() ?? "");
  const [tooExpensive, setTooExpensive] = useState(initial?.priceTooExpensiveEur?.toString() ?? "");
  const [cheap, setCheap] = useState(initial?.priceCheapEur?.toString() ?? "");
  const [interview, setInterview] = useState(initial?.interviewAccepted ?? false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(Boolean(initial?.answeredAt));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await updateOfferOpeningSurvey({
        profile: profile || null,
        salesPerMonth: parseCount(sales),
        priceTooExpensiveEur: parseCount(tooExpensive),
        priceCheapEur: parseCount(cheap),
        interviewAccepted: interview,
      });
      setSaved(true);
      toast.success("Merci, vos réponses sont enregistrées.");
    } catch (error) {
      toast.error(userMessage(error, "Réponses impossibles à enregistrer"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-label="Questions facultatives sur l’offre Analyse"
      data-testid="offer-opening-survey"
      className={`${className} grid gap-3 rounded-lg border border-border bg-white p-3 text-left text-sm`}
    >
      <p className="text-xs text-muted-foreground">{OFFER_OPENING_SURVEY_INTRO}</p>

      <label className="grid gap-1">
        <span className="font-semibold">Vous êtes plutôt…</span>
        <select
          value={profile}
          onChange={(event) => {
            setProfile(event.target.value as OfferOpeningSurveyProfile | "");
            setSaved(false);
          }}
          className="form-input"
        >
          <option value="">Je ne souhaite pas répondre</option>
          {OFFER_OPENING_SURVEY_PROFILES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="grid gap-1">
        <span className="font-semibold">Combien de ventes étudiez-vous par mois ?</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={500}
          value={sales}
          onChange={(event) => {
            setSales(event.target.value);
            setSaved(false);
          }}
          className="form-input"
        />
      </label>

      <fieldset className="grid gap-2">
        <legend className="font-semibold">Quel prix mensuel pour l’offre Analyse ?</legend>
        <label className="grid gap-1">
          <span>À partir de combien (€ par mois) la jugeriez-vous trop chère ?</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            value={tooExpensive}
            onChange={(event) => {
              setTooExpensive(event.target.value);
              setSaved(false);
            }}
            className="form-input"
          />
        </label>
        <label className="grid gap-1">
          <span>À quel prix (€ par mois) la jugeriez-vous bon marché ?</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={1000}
            value={cheap}
            onChange={(event) => {
              setCheap(event.target.value);
              setSaved(false);
            }}
            className="form-input"
          />
        </label>
      </fieldset>

      <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 leading-relaxed">
        <input
          type="checkbox"
          checked={interview}
          onChange={(event) => {
            setInterview(event.target.checked);
            setSaved(false);
          }}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="font-semibold">{OFFER_OPENING_INTERVIEW_TEXT}</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {OFFER_OPENING_INTERVIEW_HELP}
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="ij-login-button inline-flex min-h-11 items-center justify-center px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Enregistrement…" : "Enregistrer mes réponses"}
        </button>
        {saved ? (
          <span role="status" className="text-xs font-medium text-muted-foreground">
            Réponses enregistrées.
          </span>
        ) : null}
      </div>
    </form>
  );
}
