import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Gavel } from "lucide-react";

type Mode = "login" | "signup" | "forgot";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
        toast.success("Connexion réussie");
      } else if (mode === "signup") {
        if (password.length < 8) throw new Error("Mot de passe : 8 caractères minimum");
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo:
              typeof window !== "undefined" ? `${window.location.origin}/login` : undefined,
          },
        });
        if (error) throw error;
        toast.success("Compte créé. Vérifiez votre email pour confirmer votre adresse.");
        setMode("login");
      } else {
        // forgot
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo:
            typeof window !== "undefined" ? `${window.location.origin}/reset-password` : undefined,
        });
        if (error) throw error;
        toast.success("Email envoyé. Consultez votre boîte de réception.");
        setMode("login");
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  const titles: Record<Mode, { h1: string; sub: string; cta: string }> = {
    login: {
      h1: "Accès Investisseur",
      sub: "Connectez-vous pour accéder aux annonces et à votre tableau de bord.",
      cta: "Se connecter",
    },
    signup: {
      h1: "Créer un compte",
      sub: "Votre accès sera activé après validation manuelle par un administrateur.",
      cta: "Demander un accès",
    },
    forgot: {
      h1: "Mot de passe oublié",
      sub: "Recevez un lien de réinitialisation par email.",
      cta: "Envoyer le lien",
    },
  };
  const t = titles[mode];

  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8 flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center bg-[var(--gold)]">
          <Gavel className="h-4 w-4 text-[var(--background)]" />
        </span>
        <span className="font-display text-lg font-bold tracking-tight">Enchères Immo</span>
      </div>

      <div className="border border-border bg-card p-8">
        <p className="text-[10px] font-semibold uppercase tracking-[0.25em] text-[var(--gold)]">
          {mode === "signup" ? "Inscription" : mode === "forgot" ? "Réinitialisation" : "Connexion"}
        </p>
        <h1 className="mt-2 font-display text-2xl font-bold tracking-tight text-foreground">
          {t.h1}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t.sub}</p>

        <form onSubmit={submit} className="mt-6 space-y-3">
          <input
            type="email"
            required
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-input bg-background px-3 py-2.5 text-sm focus:border-[var(--gold)] focus:outline-none"
          />
          {mode !== "forgot" && (
            <input
              type="password"
              required
              minLength={mode === "signup" ? 8 : 6}
              placeholder="Mot de passe"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-input bg-background px-3 py-2.5 text-sm focus:border-[var(--gold)] focus:outline-none"
            />
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full bg-[var(--gold)] px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--background)] transition hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Chargement…" : t.cta}
          </button>
        </form>

        <div className="mt-6 flex flex-col gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
          {mode === "login" && (
            <>
              <button type="button" onClick={() => setMode("forgot")} className="text-left hover:text-foreground">
                Mot de passe oublié ?
              </button>
              <button type="button" onClick={() => setMode("signup")} className="text-left hover:text-foreground">
                Pas de compte ? <span className="text-[var(--gold)]">Demander un accès</span>
              </button>
            </>
          )}
          {mode !== "login" && (
            <button type="button" onClick={() => setMode("login")} className="text-left hover:text-foreground">
              ← Retour à la connexion
            </button>
          )}
          <Link to="/" className="text-left hover:text-foreground">
            Retour à l'accueil
          </Link>
        </div>
      </div>
    </main>
  );
}