"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { normalizeTotpCode, pickVerifiedTotpFactor, type MfaFactorSummary } from "@/lib/admin-mfa";

type Enrollment = { factorId: string; qrCode: string; secret: string };

/**
 * /admin/securite: enrol a TOTP authenticator for the administrator account. The QR code is the
 * SVG data URI returned by Supabase, so no third-party QR service is involved.
 */
export function AdminSecurityPage() {
  const [factors, setFactors] = useState<MfaFactorSummary[] | null>(null);
  const [level, setLevel] = useState<string | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [{ data: list }, { data: assurance }] = await Promise.all([
      supabase.auth.mfa.listFactors(),
      supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    ]);
    setFactors((list?.all ?? []) as MfaFactorSummary[]);
    setLevel(assurance?.currentLevel ?? null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const verified = pickVerifiedTotpFactor(factors);

  async function startEnrollment() {
    setBusy(true);
    setError(null);
    setMessage(null);
    // A previous abandoned attempt leaves an unverified factor that would block a new enrolment.
    for (const factor of factors ?? []) {
      if (factor.factor_type === "totp" && factor.status === "unverified") {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: `Immojudis admin ${new Date().toISOString().slice(0, 10)}`,
    });
    setBusy(false);
    if (enrollError || !data) {
      setError("Impossible de démarrer l'enrôlement. Réessayez dans un instant.");
      return;
    }
    setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
  }

  async function confirmEnrollment(event: FormEvent) {
    event.preventDefault();
    if (!enrollment) return;
    const normalized = normalizeTotpCode(code);
    if (!normalized) {
      setError("Saisissez le code à 6 chiffres affiché par votre application.");
      return;
    }
    setBusy(true);
    setError(null);
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: enrollment.factorId,
    });
    if (challengeError || !challenge) {
      setBusy(false);
      setError("Impossible de lancer la vérification. Réessayez dans un instant.");
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: enrollment.factorId,
      challengeId: challenge.id,
      code: normalized,
    });
    setBusy(false);
    if (verifyError) {
      setError("Code incorrect ou expiré.");
      setCode("");
      return;
    }
    setEnrollment(null);
    setCode("");
    setMessage("Double authentification activée pour ce compte.");
    await refresh();
  }

  return (
    <main className="liquid-page mx-auto max-w-2xl px-4 py-10">
      <div className="liquid-panel rounded-lg p-6">
        <h1 className="font-display text-2xl text-foreground">Sécurité du compte administrateur</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          La double authentification (TOTP) protège l'administration. Une fois activée, elle sera
          exigée pour toutes les pages et routes d'administration.
        </p>

        {factors === null ? (
          <p className="mt-6 text-sm text-muted-foreground">Chargement…</p>
        ) : verified ? (
          <p className="mt-6 text-sm text-foreground">
            Application d'authentification active
            {level === "aal2"
              ? " (session vérifiée)."
              : " (session à vérifier à la prochaine page)."}
          </p>
        ) : enrollment ? (
          <form onSubmit={confirmEnrollment} className="mt-6 space-y-4">
            <p className="text-sm text-muted-foreground">
              Scannez ce code avec votre application (Google Authenticator, 1Password, Authy…), puis
              saisissez le code à 6 chiffres.
            </p>
            <img
              src={enrollment.qrCode}
              alt="QR code d'enrôlement de l'application d'authentification"
              className="h-48 w-48 rounded bg-white p-2"
            />
            <p className="break-all text-xs text-muted-foreground">
              Clé de saisie manuelle : <code>{enrollment.secret}</code>
            </p>
            <label className="block text-xs font-semibold uppercase tracking-[0.16em] text-gold">
              Code à 6 chiffres
              <input
                className="form-input mt-2 w-full tracking-[0.4em]"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={9}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </label>
            <button
              type="submit"
              disabled={busy}
              className="liquid-button inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background disabled:opacity-60"
            >
              {busy ? "Vérification…" : "Activer"}
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => void startEnrollment()}
            disabled={busy}
            className="liquid-button mt-6 inline-flex items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background disabled:opacity-60"
          >
            Configurer l'application d'authentification
          </button>
        )}

        {message ? (
          <p role="status" className="mt-4 text-sm text-emerald-300">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-red-300">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  );
}
