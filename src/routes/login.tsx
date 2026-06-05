import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  ACCOUNT_TYPE_OPTIONS,
  PROFESSIONAL_ROLE_OPTIONS,
  type AccountType,
  type ProfessionalRole,
} from "@/lib/account";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("b2c");
  const [professionalRole, setProfessionalRole] = useState<ProfessionalRole>("lawyer");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (user) navigate({ to: "/sales" });
  }, [user, navigate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Connecté");
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: typeof window !== "undefined" ? window.location.origin : undefined,
            data: {
              account_type: accountType,
              professional_role: accountType === "b2b" ? professionalRole : null,
              onboarding_version: "2026-06-b2c-b2b",
            },
          },
        });
        if (error) throw error;
        toast.success(
          accountType === "b2b"
            ? "Compte professionnel créé. Vérifiez votre email si la confirmation est activée."
            : "Compte investisseur créé. Vérifiez votre email si la confirmation est activée.",
        );
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-semibold text-foreground">
          {mode === "login" ? "Connexion" : "Créer un compte"}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "login"
            ? "Connectez-vous pour accéder aux annonces, cartes, favoris et alertes."
            : "Choisissez le bon profil pour accéder aux fonctionnalités adaptées."}
        </p>
        <form onSubmit={submit} className="mt-5 space-y-3">
          {mode === "signup" ? (
            <div className="grid gap-3">
              <div className="grid gap-2">
                {ACCOUNT_TYPE_OPTIONS.map((option) => (
                  <label key={option.value} className="choice-card items-start">
                    <input
                      type="radio"
                      name="accountType"
                      value={option.value}
                      checked={accountType === option.value}
                      onChange={() => setAccountType(option.value)}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-sm font-semibold text-foreground">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        {option.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              {accountType === "b2b" ? (
                <label className="grid gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Profession
                  </span>
                  <select
                    value={professionalRole}
                    onChange={(event) =>
                      setProfessionalRole(event.target.value as ProfessionalRole)
                    }
                    className="form-input"
                  >
                    {PROFESSIONAL_ROLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    La publication est réservée aux professionnels. Une vérification pourra être
                    demandée avant mise en ligne ou référencement payant.
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <input
            type="password"
            required
            minLength={6}
            placeholder="Mot de passe"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? "Chargement…" : mode === "login" ? "Se connecter" : "Créer le compte"}
          </button>
        </form>
        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
          className="mt-4 text-xs text-muted-foreground hover:text-foreground"
        >
          {mode === "login" ? "Pas encore de compte ? S'inscrire" : "Déjà inscrit ? Se connecter"}
        </button>
        <div className="mt-6 border-t border-border pt-4 text-center text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground">
            ← Retour à la présentation
          </Link>
        </div>
      </div>
    </main>
  );
}
