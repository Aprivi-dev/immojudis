"use client";

import { createFileRoute, Link, useNavigate } from "@/lib/router-compat";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import BriefcaseBusiness from "lucide-react/dist/esm/icons/briefcase-business.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import Eye from "lucide-react/dist/esm/icons/eye.js";
import EyeOff from "lucide-react/dist/esm/icons/eye-off.js";
import FileSearch from "lucide-react/dist/esm/icons/file-search.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import Mail from "lucide-react/dist/esm/icons/mail.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import UserRound from "lucide-react/dist/esm/icons/user-round.js";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { isSupabaseConfigured, supabase } from "@/integrations/supabase/client";
import {
  getAccountType,
  isAdminAccount,
  PROFESSIONAL_ROLE_OPTIONS,
  type AccountType,
  type ProfessionalRole,
} from "@/lib/account";
import { loginPageMode, type LoginPageMode } from "@/lib/navigation";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { postAuthDestination } from "@/lib/onboarding";
import { userMessage } from "@/lib/user-messages";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => {
    const redirect = safeRedirect(search.redirect);
    const mode = loginPageMode(search.mode);
    return {
      ...(redirect ? { redirect } : {}),
      ...(mode !== "login" ? { mode } : {}),
    };
  },
  component: LoginPage,
});

type LoginSearch = {
  redirect?: string;
  mode?: Exclude<LoginPageMode, "login">;
};

type LoginMode = LoginPageMode;

const modeCopy: Record<
  LoginMode,
  {
    eyebrow: string;
    title: string;
    description: string;
    submit: string;
  }
> = {
  login: {
    eyebrow: "Connexion",
    title: "Reprendre votre analyse",
    description: "Accédez aux annonces, favoris, alertes et enchères plafonds déjà préparées.",
    submit: "Se connecter",
  },
  investor: {
    eyebrow: "Compte Découverte",
    title: "Explorer gratuitement",
    description:
      "Créez votre compte pour consulter les fiches et préparer votre première recherche, sans carte bancaire.",
    submit: "Créer mon compte gratuit",
  },
  professional: {
    eyebrow: "Compte professionnel",
    title: "Référencer une vente",
    description: "Un espace B2B pour les avocats, notaires, commissaires de justice et tribunaux.",
    submit: "Demander mon accès pro",
  },
};

export function LoginPage() {
  const { user, profile, loading } = useAuth();
  const { redirect, mode: requestedMode } = Route.useSearch();
  const navigate = useNavigate();
  const mode: LoginMode = requestedMode ?? "login";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [professionalRole, setProfessionalRole] = useState<ProfessionalRole>("lawyer");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const copy = modeCopy[mode];
  const isSignup = mode !== "login";
  const accountType: AccountType = mode === "professional" ? "b2b" : "b2c";
  const postAuthTarget = useMemo(
    () =>
      postAuthDestination({
        mode,
        redirect,
        professional: isAdminAccount(user, profile) || getAccountType(user, profile) === "b2b",
      }),
    [mode, profile, redirect, user],
  );

  useEffect(() => {
    if (user && !loading) navigate({ to: postAuthTarget });
  }, [loading, navigate, postAuthTarget, user]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!isSupabaseConfigured) {
      toast.error("Connexion indisponible : Supabase n'est pas configuré sur ce déploiement.");
      return;
    }

    if (mode === "professional" && organizationName.trim().length < 2) {
      toast.error("Renseignez votre cabinet, étude, office ou tribunal.");
      return;
    }

    setFormError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast.success("Connecté");
        return;
      }

      const redirectPath = postAuthDestination({
        mode,
        redirect,
        professional: accountType === "b2b",
      });
      const origin = typeof window !== "undefined" ? window.location.origin : undefined;
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: origin ? `${origin}${redirectPath}` : undefined,
          data: {
            account_type: accountType,
            full_name: fullName.trim() || null,
            organization_name: accountType === "b2b" ? organizationName.trim() : null,
            professional_role: accountType === "b2b" ? professionalRole : null,
            onboarding_version:
              accountType === "b2b" ? "2026-06-split-investor-pro" : "2026-08-first-search",
            terms_version: LEGAL_DOCUMENTS.terms.version,
            privacy_version: LEGAL_DOCUMENTS.privacy.version,
            terms_accepted_at: new Date().toISOString(),
          },
        },
      });
      if (error) throw error;
      toast.success(
        accountType === "b2b"
          ? "Demande pro créée. Vérifiez votre email si la confirmation est activée."
          : "Compte Découverte créé. Vérifiez votre email si la confirmation est activée.",
      );
    } catch (err: unknown) {
      const message = userMessage(
        err,
        "Impossible de continuer. Vérifiez vos informations puis réessayez.",
      );
      setFormError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="contenu" className="liquid-page min-h-screen px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto grid min-h-[calc(100svh-8rem)] max-w-6xl items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,29rem)]">
        <section className="glass-shell relative hidden min-h-[38rem] overflow-hidden rounded-lg p-8 lg:block">
          <div className="cinematic-grid absolute inset-0 opacity-35" />
          <div className="absolute inset-x-10 top-16 h-px bg-gradient-to-r from-transparent via-gold/50 to-transparent" />
          <div className="relative z-10 max-w-xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-gold/25 bg-gold/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-gold-text">
              <ShieldCheck className="h-3.5 w-3.5" />
              Accès Immojudis
            </div>
            <p className="mt-6 font-display text-5xl leading-tight text-foreground">
              Préparez votre achat aux enchères.
            </p>
            <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
              Découverte ouvre gratuitement le catalogue. Analyse ajoute le calcul de votre enchère
              plafond, les comparables et les alertes, sur abonnement résiliable. Les professionnels
              déposent et suivent leurs annonces dans leur espace.
            </p>

            <div className="mt-10 grid gap-3">
              <FeatureLine
                icon={FileSearch}
                title="Découverte"
                text="Explorer les annonces et les aperçus gratuitement."
              />
              <FeatureLine
                icon={BriefcaseBusiness}
                title="Professionnel"
                text="Référencer une vente et structurer le dossier."
              />
            </div>
          </div>
        </section>

        <section className="glass-shell rounded-lg p-6 sm:p-8">
          <div className="grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-1">
            <ModeButton
              active={mode === "login"}
              onClick={() =>
                navigate({
                  search: (previous) => ({ ...previous, mode: undefined }),
                  replace: true,
                })
              }
            >
              Se connecter
            </ModeButton>
            <ModeButton
              active={mode === "investor"}
              onClick={() =>
                navigate({
                  search: (previous) => ({ ...previous, mode: "investor" }),
                  replace: true,
                })
              }
            >
              Créer un compte
            </ModeButton>
            <ModeButton
              active={mode === "professional"}
              onClick={() =>
                navigate({
                  search: (previous) => ({ ...previous, mode: "professional" }),
                  replace: true,
                })
              }
            >
              Professionnel
            </ModeButton>
          </div>

          <div className="mt-6 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-gold-text">
            {mode === "professional" ? (
              <BriefcaseBusiness className="h-4 w-4" />
            ) : mode === "investor" ? (
              <UserRound className="h-4 w-4" />
            ) : (
              <LockKeyhole className="h-4 w-4" />
            )}
            {copy.eyebrow}
          </div>
          <h1 className="mt-4 font-display text-3xl text-foreground">{copy.title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.description}</p>

          {!isSupabaseConfigured ? (
            <div className="mt-5 rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm leading-relaxed text-red-100">
              Connexion temporairement indisponible : les variables Supabase publiques ne sont pas
              présentes dans ce build.
            </div>
          ) : null}

          <form onSubmit={submit} className="mt-6 space-y-3">
            {isSignup ? (
              <label className="grid gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Nom complet
                </span>
                <input
                  type="text"
                  placeholder="Prénom Nom"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="form-input"
                />
              </label>
            ) : null}

            {mode === "professional" ? (
              <div className="grid gap-3">
                <label className="grid gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Profil professionnel
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
                </label>
                <label className="grid gap-2">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Organisation
                  </span>
                  <div className="relative">
                    <Building2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gold/80" />
                    <input
                      type="text"
                      required
                      placeholder="Cabinet, étude, office, tribunal..."
                      value={organizationName}
                      onChange={(e) => setOrganizationName(e.target.value)}
                      className="form-input pl-10"
                    />
                  </div>
                </label>
                <div className="rounded-lg border border-gold/20 bg-gold/10 px-4 py-3 text-xs leading-relaxed text-gold-text">
                  L'accès pro permet de préparer une annonce. La publication et les options de
                  référencement pourront être validées séparément.
                </div>
              </div>
            ) : null}

            <label className="grid gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Email
              </span>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gold/80" />
                <input
                  type="email"
                  autoComplete="email"
                  required
                  placeholder="vous@exemple.fr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="form-input pl-10"
                />
              </div>
            </label>
            <label className="grid gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Mot de passe
              </span>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gold/80" />
                <input
                  type={showPassword ? "text" : "password"}
                  autoComplete={isSignup ? "new-password" : "current-password"}
                  required
                  minLength={isSignup ? 12 : 6}
                  placeholder={isSignup ? "12 caractères minimum" : "Votre mot de passe"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="form-input pl-10 pr-11"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                  aria-pressed={showPassword}
                  className="absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </label>

            {!isSignup ? (
              <div className="pb-2 text-right">
                <Link to="/mot-de-passe-oublie" className="text-sm underline">
                  Mot de passe oublié ?
                </Link>
              </div>
            ) : null}
            {formError ? (
              <p
                role="alert"
                className="rounded-lg border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm leading-relaxed text-red-700"
              >
                {formError}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={busy}
              className="liquid-button inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 text-sm font-semibold transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Chargement..." : copy.submit}
              {!busy ? <ArrowRight className="h-4 w-4" /> : null}
            </button>
            {isSignup ? (
              <p className="text-center text-xs leading-relaxed text-muted-foreground">
                En créant un compte, vous acceptez les{" "}
                <Link to="/conditions-generales" className="underline">
                  conditions générales
                </Link>{" "}
                et la{" "}
                <Link to="/privacy" className="underline">
                  politique de confidentialité
                </Link>
                .
              </p>
            ) : null}
          </form>

          <div className="mt-6 border-t border-white/10 pt-4 text-center text-xs text-muted-foreground">
            <Link to="/" className="hover:text-foreground">
              Retour à la présentation
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}

function safeRedirect(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    !value.startsWith("/") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) <= 32)
  )
    return undefined;
  const base = "http://immojudis.local";
  try {
    const url = new URL(value, base);
    if (url.origin !== base || url.pathname === "/login") return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

function ModeButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-2 text-sm font-semibold transition ${
        active
          ? "bg-gold text-brand-navy shadow-[0_12px_28px_rgb(242_196_135_/_18%)]"
          : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function FeatureLine({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof FileSearch;
  title: string;
  text: string;
}) {
  return (
    <div className="liquid-panel-soft flex items-start gap-3 rounded-lg p-4">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-gold-text" />
      <div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
