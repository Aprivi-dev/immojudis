"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { AdminPanel, AdminShell } from "@/components/admin/AdminShell";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { normalizeTotpCode, pickVerifiedTotpFactor, type MfaFactorSummary } from "@/lib/admin-mfa";

type Enrollment = { factorId: string; qrCode: string; secret: string };

/**
 * /admin/securite: enrol a TOTP authenticator for the administrator account. The QR code is the
 * SVG data URI returned by Supabase, so no third-party QR service is involved. Reached from the
 * « Sécurité du compte » link under the administrator's address in the admin menu.
 */
export function AdminSecurityPage() {
  const { user } = useAuth();
  const [factors, setFactors] = useState<MfaFactorSummary[] | null>(null);
  const [level, setLevel] = useState<string | null>(null);
  // Reading the factors failed (thrown or returned error): say so instead of loading forever, and
  // never offer an enrolment based on an unknown state.
  const [loadFailed, setLoadFailed] = useState(false);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [{ data: list, error: listError }, { data: assurance, error: levelError }] =
        await Promise.all([
          supabase.auth.mfa.listFactors(),
          supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
        ]);
      if (listError || levelError) throw listError ?? levelError;
      setFactors((list?.all ?? []) as MfaFactorSummary[]);
      setLevel(assurance?.currentLevel ?? null);
    } catch {
      setFactors(null);
      setLoadFailed(true);
    }
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
    <AdminShell
      activeSection="security"
      title="Sécurité du compte"
      description="Double authentification du compte administrateur."
      adminEmail={user?.email}
    >
      <AdminPanel className="max-w-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-brand-navy">Application d’authentification</h2>
        <p className="mt-2 text-sm leading-relaxed text-brand-navy/70">
          La double authentification (TOTP) protège l'administration. Une fois activée, elle sera
          exigée pour toutes les pages et routes d'administration.
        </p>

        {loadFailed ? (
          <div
            role="alert"
            className="mt-6 rounded-lg border border-danger/30 bg-danger-tint p-4 text-sm text-danger"
          >
            <p>
              L’état de la double authentification n’a pas pu être lu. Vérifiez votre connexion,
              puis réessayez.
            </p>
            <button
              type="button"
              className="admin-button-secondary mt-3"
              onClick={() => void refresh()}
            >
              Réessayer
            </button>
          </div>
        ) : factors === null ? (
          <p role="status" className="mt-6 text-sm text-brand-navy/60">
            Chargement…
          </p>
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
            <label className="grid gap-1.5 text-sm font-medium text-brand-navy/80">
              Code à 6 chiffres
              <input
                className="w-full rounded-lg border border-brand-navy/55 bg-white px-3 py-2 text-sm tracking-[0.4em] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
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
              className="admin-button-primary disabled:opacity-60"
            >
              {busy ? "Vérification…" : "Activer"}
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => void startEnrollment()}
            disabled={busy}
            className="admin-button-primary mt-6 disabled:opacity-60"
          >
            Configurer l'application d'authentification
          </button>
        )}

        {message ? (
          <p role="status" className="mt-4 text-sm text-success">
            {message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </AdminPanel>
    </AdminShell>
  );
}
