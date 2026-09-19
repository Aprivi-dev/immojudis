"use client";

import Activity from "lucide-react/dist/esm/icons/activity.js";
import Bot from "lucide-react/dist/esm/icons/bot.js";
import BarChart3 from "lucide-react/dist/esm/icons/bar-chart-3.js";
import BriefcaseBusiness from "lucide-react/dist/esm/icons/briefcase-business.js";
import Settings from "lucide-react/dist/esm/icons/settings.js";
import CreditCard from "lucide-react/dist/esm/icons/credit-card.js";
import Database from "lucide-react/dist/esm/icons/database.js";
import FileCheck2 from "lucide-react/dist/esm/icons/file-check-2.js";
import LayoutDashboard from "lucide-react/dist/esm/icons/layout-dashboard.js";
import Menu from "lucide-react/dist/esm/icons/menu.js";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw.js";
import Scale from "lucide-react/dist/esm/icons/scale.js";
import Search from "lucide-react/dist/esm/icons/search.js";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "@/lib/router-compat";

export type AdminSection =
  | "settings"
  | "overview"
  | "operations"
  | "agent"
  | "quality"
  | "publications"
  | "clients"
  | "lawyers"
  | "compliance";

const ADMIN_NAV_ITEMS: Array<{
  section: AdminSection;
  href: string;
  label: string;
  icon: typeof Activity;
}> = [
  { section: "overview", href: "/admin", label: "Vue d’ensemble", icon: LayoutDashboard },
  { section: "operations", href: "/admin/operations", label: "Opérations", icon: Database },
  { section: "agent", href: "/admin/agent-ia", label: "Agent IA", icon: Bot },
  { section: "quality", href: "/admin/quality", label: "Qualité des données", icon: BarChart3 },
  { section: "publications", href: "/admin/publications", label: "Publications", icon: FileCheck2 },
  { section: "clients", href: "/admin/clients", label: "Clients & abonnements", icon: CreditCard },
  { section: "lawyers", href: "/admin/lawyers", label: "Avocats", icon: Scale },
  { section: "compliance", href: "/admin/compliance", label: "Conformité", icon: ShieldCheck },
  { section: "settings", href: "/admin/settings", label: "Configuration", icon: Settings },
];

export function AdminShell({
  activeSection,
  title,
  description,
  adminEmail,
  searchValue,
  searchPlaceholder = "Rechercher…",
  onSearchChange,
  onRefresh,
  isRefreshing = false,
  primaryAction,
  children,
}: {
  activeSection: AdminSection;
  title: string;
  description: string;
  adminEmail?: string | null;
  searchValue?: string;
  searchPlaceholder?: string;
  onSearchChange?: (value: string) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  primaryAction?: ReactNode;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <main className="admin-console min-h-screen bg-[#f5f9fd] text-[#132238]">
      <aside className="admin-sidebar hidden lg:flex">
        <AdminSidebarContent
          activeSection={activeSection}
          adminEmail={adminEmail}
          onNavigate={() => setMobileOpen(false)}
        />
      </aside>

      <div className="min-w-0 lg:pl-[15rem]">
        <header className="admin-topbar">
          <div className="flex min-w-0 items-start gap-3">
            <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
              <DialogTrigger asChild>
                <button
                  type="button"
                  aria-label="Ouvrir la navigation administrateur"
                  className="mt-1 grid size-10 shrink-0 place-items-center rounded-lg border border-[#132238]/15 bg-white text-[#132238] lg:hidden"
                >
                  <Menu className="size-5" />
                </button>
              </DialogTrigger>
              <DialogContent className="left-0 top-0 h-dvh w-[min(20rem,88vw)] max-w-none translate-x-0 translate-y-0 rounded-none border-0 bg-[#132238] p-0 text-white sm:rounded-none">
                <DialogTitle className="sr-only">Navigation administrateur</DialogTitle>
                <DialogDescription className="sr-only">
                  Accédez aux outils et aux réglages ImmoJudis.
                </DialogDescription>
                <AdminSidebarContent
                  activeSection={activeSection}
                  adminEmail={adminEmail}
                  onNavigate={() => setMobileOpen(false)}
                />
              </DialogContent>
            </Dialog>
            <div className="min-w-0">
              <h1 className="font-display text-[clamp(2.35rem,4vw,3.25rem)] font-medium leading-[0.98] text-[#132238]">
                {title}
              </h1>
              <p className="mt-2 text-sm text-[#132238]/68 sm:text-base">{description}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end xl:flex-nowrap">
            {onSearchChange ? (
              <label className="admin-search">
                <Search className="size-4 shrink-0 text-[#132238]/55" />
                <span className="sr-only">Rechercher dans la vue</span>
                <input
                  type="search"
                  value={searchValue ?? ""}
                  onChange={(event) => onSearchChange(event.target.value)}
                  placeholder={searchPlaceholder}
                />
              </label>
            ) : null}
            {onRefresh ? (
              <button
                type="button"
                onClick={onRefresh}
                disabled={isRefreshing}
                aria-busy={isRefreshing}
                className="admin-button-secondary disabled:opacity-50"
              >
                <RefreshCw className={`size-4 ${isRefreshing ? "animate-spin" : ""}`} />
                {isRefreshing ? "Actualisation…" : "Actualiser"}
              </button>
            ) : null}
            {primaryAction}
          </div>
        </header>

        <div className="admin-console-content">{children}</div>
      </div>
    </main>
  );
}

function AdminSidebarContent({
  activeSection,
  adminEmail,
  onNavigate,
}: {
  activeSection: AdminSection;
  adminEmail?: string | null;
  onNavigate: () => void;
}) {
  const initials = (adminEmail?.split("@")[0] || "AD").slice(0, 2).toUpperCase();

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <Link
        to="/"
        onClick={onNavigate}
        className="shrink-0 px-6 pb-8 pt-7 font-display text-[2rem] font-semibold leading-none text-[#d99549]"
        aria-label="ImmoJudis — accueil"
      >
        ImmoJudis
      </Link>

      <nav
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2"
        aria-label="Navigation administrateur"
      >
        {ADMIN_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.section === activeSection;
          return (
            <Link
              key={item.section}
              to={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`admin-sidebar-link ${active ? "admin-sidebar-link-active" : ""}`}
            >
              <Icon className="size-[1.15rem] shrink-0" strokeWidth={1.8} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="m-3 flex shrink-0 items-center gap-3 rounded-xl border border-white/10 bg-white/[0.06] p-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[#d58c3f] text-xs font-bold text-white">
          {initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-white">Administrateur</span>
          <span className="block truncate text-xs text-white/58">{adminEmail || "ImmoJudis"}</span>
        </span>
      </div>
    </div>
  );
}

export function AdminPrimaryButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="admin-button-primary" {...props}>
      {children}
    </button>
  );
}

export function AdminPanel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`admin-panel ${className}`}>{children}</section>;
}

export function AdminSectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="text-lg font-semibold tracking-[-0.01em] text-[#132238]">{title}</h2>
        {description ? <p className="mt-1 text-sm text-[#132238]/62">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
