"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";

export function PasswordRecovery({ reset = false }: { reset?: boolean }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(!reset);
  const [checking, setChecking] = useState(reset);
  const [done, setDone] = useState(false);
  const [needsNewRecoveryLink, setNeedsNewRecoveryLink] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!reset) return;
    let active = true;
    const invalidLink =
      new URLSearchParams(window.location.hash.slice(1)).has("error") ||
      new URLSearchParams(window.location.search).has("error");
    if (invalidLink) {
      setChecking(false);
      setError("Ce lien est invalide ou a expiré. Demandez un nouveau lien.");
      return;
    }
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) {
        setReady(Boolean(session));
        setChecking(false);
      }
    });
    void supabase.auth
      .getSession()
      .then(({ data, error: sessionError }) => {
        if (!active) return;
        setReady(Boolean(data.session) && !sessionError);
        setChecking(false);
      })
      .catch(() => {
        if (active) {
          setReady(false);
          setChecking(false);
        }
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [reset]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!isSupabaseConfigured) {
      setError("La récupération du compte est temporairement indisponible.");
      return;
    }
    if (reset && password !== confirmation) {
      setError("Les deux mots de passe doivent être identiques.");
      return;
    }
    setBusy(true);
    try {
      if (reset) {
        const { error: updateError } = await supabase.auth.updateUser({ password });
        if (
          updateError?.code &&
          [
            "reauthentication_needed",
            "reauthentication_not_valid",
            "current_password_required",
            "current_password_invalid",
            "current_password_mismatch",
          ].includes(updateError.code)
        ) {
          // This page is a recovery flow. A new recovery link creates a fresh
          // recovery session, including when another login session was present.
          setNeedsNewRecoveryLink(true);
          return;
        }
        if (updateError) throw updateError;
        setDone(true);
        // The password has already changed even if signing out encounters a network error.
        await supabase.auth.signOut().catch(() => undefined);
      } else {
        const { error: sendError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: `${window.location.origin}/reinitialiser-mot-de-passe`,
        });
        if (sendError) throw sendError;
        setDone(true);
      }
    } catch {
      setError(
        reset
          ? "Le mot de passe n’a pas pu être modifié. Vérifiez le lien et choisissez un mot de passe conforme aux exigences du compte."
          : "La demande n’a pas pu être envoyée. Réessayez dans quelques instants.",
      );
    } finally {
      setBusy(false);
    }
  }

  const invalid = reset && !checking && (!ready || needsNewRecoveryLink);
  return (
    <main className="liquid-page min-h-[75vh] px-4 py-12 text-foreground">
      <section className="glass-shell mx-auto max-w-md rounded-lg p-6 sm:p-8">
        <h1 className="font-display text-3xl">
          {reset ? "Nouveau mot de passe" : "Mot de passe oublié"}
        </h1>
        {done ? (
          <p role="status" className="mt-5 text-sm leading-relaxed">
            {reset
              ? "Votre mot de passe a été modifié. Vous pouvez vous reconnecter."
              : "Si un compte correspond à cette adresse, vous recevrez un lien pour choisir un nouveau mot de passe. Pensez à vérifier vos courriers indésirables."}
          </p>
        ) : checking ? (
          <p role="status" className="mt-5">
            Vérification du lien…
          </p>
        ) : invalid ? (
          <p className="mt-5 text-sm">
            {needsNewRecoveryLink
              ? "Pour confirmer votre identité, demandez un nouveau lien de récupération avant de changer votre mot de passe."
              : "Ce lien est invalide ou a expiré. Demandez un nouveau lien pour continuer."}
          </p>
        ) : (
          <form onSubmit={submit} className="mt-6 grid gap-5">
            {reset ? (
              <>
                <label className="grid gap-2 text-sm">
                  Nouveau mot de passe
                  <input
                    autoComplete="new-password"
                    type="password"
                    required
                    minLength={12}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="form-input"
                  />
                </label>
                <p className="text-xs text-muted-foreground">Au moins 12 caractères.</p>
                <label className="grid gap-2 text-sm">
                  Confirmer le mot de passe
                  <input
                    autoComplete="new-password"
                    type="password"
                    required
                    minLength={12}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    className="form-input"
                  />
                </label>
              </>
            ) : (
              <label className="grid gap-2 text-sm">
                Adresse email du compte
                <input
                  autoComplete="email"
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="form-input"
                />
              </label>
            )}
            <button
              type="submit"
              disabled={busy}
              className="liquid-button rounded-lg px-4 py-3 text-sm font-semibold disabled:opacity-50"
            >
              {busy
                ? "Veuillez patienter…"
                : reset
                  ? "Enregistrer le mot de passe"
                  : "Recevoir le lien de réinitialisation"}
            </button>
          </form>
        )}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        {invalid ? (
          <Link href="/mot-de-passe-oublie" className="mt-5 block text-sm underline">
            Demander un nouveau lien
          </Link>
        ) : null}
        <Link href="/login" className="mt-6 block text-sm underline">
          Retour à la connexion
        </Link>
      </section>
    </main>
  );
}
