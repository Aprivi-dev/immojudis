"use client";

import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  needsMfaChallenge,
  normalizeTotpCode,
  pickVerifiedTotpFactor,
  type AuthenticatorAssurance,
} from "@/lib/admin-mfa";

type GateState =
  | { status: "checking" }
  | { status: "open" }
  | { status: "challenge"; factorId: string };

/**
 * Shows the "Code de vérification" screen before any admin page when the signed-in
 * administrator has a verified TOTP factor but the session is still aal1. Accounts without a
 * factor pass through (the server only blocks them once ADMIN_MFA_REQUIRED is switched on, and
 * /admin/securite lets them enrol).
 */
export function AdminMfaGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ status: "checking" });

  const check = useCallback(async () => {
    try {
      const { data: assurance, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error || !needsMfaChallenge(assurance as AuthenticatorAssurance)) {
        setState({ status: "open" });
        return;
      }
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const factor = pickVerifiedTotpFactor(factors?.all);
      setState(factor ? { status: "challenge", factorId: factor.id } : { status: "open" });
    } catch {
      // Never trap the page on an auth-service hiccup: the API enforces the requirement anyway.
      setState({ status: "open" });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  if (state.status === "checking") return null;
  if (state.status === "open") return <>{children}</>;
  return <MfaChallenge factorId={state.factorId} onVerified={() => setState({ status: "open" })} />;
}

function MfaChallenge({ factorId, onVerified }: { factorId: string; onVerified: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeTotpCode(code);
    if (!normalized) {
      setError("Saisissez le code à 6 chiffres affiché par votre application.");
      return;
    }
    setBusy(true);
    setError(null);
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (challengeError || !challenge) {
      setBusy(false);
      setError("Impossible de lancer la vérification. Réessayez dans un instant.");
      return;
    }
    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: normalized,
    });
    setBusy(false);
    if (verifyError) {
      setError("Code incorrect ou expiré.");
      setCode("");
      return;
    }
    onVerified();
  }

  return (
    <main className="liquid-page flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="liquid-panel w-full max-w-md rounded-lg p-6">
        <h1 className="font-display text-2xl text-foreground">Code de vérification</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Entrez le code à 6 chiffres de votre application d'authentification pour accéder à
          l'administration.
        </p>
        <label className="mt-5 block text-xs font-semibold uppercase tracking-[0.16em] text-gold">
          Code à 6 chiffres
          <input
            className="form-input mt-2 w-full tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={9}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            aria-invalid={error ? true : undefined}
          />
        </label>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="liquid-button mt-6 inline-flex w-full items-center justify-center rounded-lg px-5 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background disabled:opacity-60"
        >
          {busy ? "Vérification…" : "Vérifier"}
        </button>
      </form>
    </main>
  );
}
