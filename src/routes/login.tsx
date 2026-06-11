import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import { toast } from "sonner";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { BrandMark } from "@/components/BrandLogo";
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
    if (!isSupabaseConfigured) {
      toast.error("Connexion indisponible : Supabase n'est pas configuré sur ce déploiement.");
      return;
    }

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
    <main className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto grid min-h-[calc(100svh-8rem)] max-w-6xl items-center gap-8 lg:grid-cols-[1fr_28rem]">
        <section className="relative hidden min-h-[36rem] overflow-hidden rounded-lg lg:block">
          <div className="glass-shell absolute inset-0" />
          <div className="cinematic-grid absolute inset-0 opacity-40" />
          <div className="relative z-10 p-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-gold/25 bg-gold/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-gold-soft">
              <ShieldCheck className="h-3.5 w-3.5" />
              Accès protégé
            </div>
            <h1 className="mt-6 max-w-xl font-display text-5xl leading-tight text-foreground">
              Entrez dans le poste de lecture Immojudis.
            </h1>
            <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
              Un compte donne accès aux annonces, scores, favoris, alertes et lectures de marché.
              Les comptes professionnels débloquent la publication.
            </p>
          </div>
          <BrandMark className="absolute bottom-10 right-10 z-20 h-44 w-44 max-w-[58%] opacity-90 drop-shadow-[0_34px_70px_rgba(0,0,0,0.55)]" />
        </section>

        <section className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-gold">
            <ShieldCheck className="h-4 w-4" />
            {mode === "login" ? "Connexion" : "Onboarding"}
          </div>
          <h1 className="mt-4 font-display text-3xl text-foreground">
            {mode === "login" ? "Accès investisseur" : "Créer un compte"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {mode === "login"
              ? "Connectez-vous pour accéder aux annonces, cartes, favoris et alertes."
              : "Choisissez le bon profil pour accéder aux fonctionnalités adaptées."}
          </p>
          {!isSupabaseConfigured ? (
            <div className="mt-5 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm leading-relaxed text-red-100">
              Connexion temporairement indisponible : les variables Supabase publiques ne sont pas
              présentes dans ce build.
            </div>
          ) : null}
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
              className="form-input"
            />
            <input
              type="password"
              required
              minLength={6}
              placeholder="Mot de passe"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="form-input"
            />
            <button
              type="submit"
              disabled={busy}
              className="liquid-button inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-xs font-bold uppercase tracking-[0.18em] text-background transition hover:brightness-105 disabled:opacity-50"
            >
              {busy ? "Chargement…" : mode === "login" ? "Se connecter" : "Créer le compte"}
              {!busy ? <ArrowRight className="h-4 w-4" /> : null}
            </button>
          </form>
          <button
            type="button"
            onClick={() => setMode(mode === "login" ? "signup" : "login")}
            className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-gold hover:text-gold-soft"
          >
            {mode === "login" ? "Pas encore de compte ? S'inscrire" : "Déjà inscrit ? Se connecter"}
          </button>
          <div className="mt-6 border-t border-white/10 pt-4 text-center text-xs text-muted-foreground">
            <Link to="/" className="hover:text-foreground">
              ← Retour à la présentation
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
