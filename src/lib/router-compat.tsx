"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import NextLink from "next/link";
import {
  notFound as nextNotFound,
  redirect as nextRedirect,
  useParams as useNextParams,
  usePathname,
  useRouter as useNextRouter,
  useSearchParams,
} from "next/navigation";
import type * as React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";

type SearchRecord = Record<string, unknown>;
type ParamsRecord = Record<string, string | string[] | undefined>;

type RouteOptions = {
  component?: React.ComponentType;
  loader?: (args: any) => any;
  validateSearch?: (search: any) => any;
  head?: (args?: any) => unknown;
  beforeLoad?: (args?: any) => unknown;
  errorComponent?: React.ComponentType<{ error: Error; reset: () => void }>;
  notFoundComponent?: React.ComponentType;
  pendingComponent?: React.ComponentType;
};

type CompatRoute = RouteOptions & {
  path: string;
  options: RouteOptions;
  useSearch: <TSearch = any>() => TSearch;
  useParams: <TParams = any>() => TParams;
  useLoaderData: <TLoaderData = any>() => TLoaderData;
  useRouteContext: <TContext = any>() => TContext;
};

type RouteCompatValue = {
  loaderData?: unknown;
  params?: ParamsRecord;
  routeContext?: Record<string, unknown>;
};

const RouteCompatContext = createContext<RouteCompatValue>({});

export function RouteCompatProvider({
  children,
  loaderData,
  params,
  routeContext,
}: RouteCompatValue & { children: React.ReactNode }) {
  const value = useMemo(
    () => ({ loaderData, params, routeContext }),
    [loaderData, params, routeContext],
  );
  return <RouteCompatContext.Provider value={value}>{children}</RouteCompatContext.Provider>;
}

type SearchParamsLike = {
  forEach(callback: (value: string, key: string) => void): void;
};

function searchParamsToObject(searchParams: SearchParamsLike): SearchRecord {
  const next: SearchRecord = {};
  searchParams.forEach((value, key) => {
    const numeric = Number(value);
    next[key] = value.trim() !== "" && Number.isFinite(numeric) ? numeric : value;
  });
  return next;
}

function createCompatRoute(path: string, options: RouteOptions): CompatRoute {
  const route = {
    ...options,
    path,
    options,
    useSearch() {
      const searchParams = useSearchParams();
      const searchParamsKey = searchParams.toString();
      return useMemo(() => {
        const raw = searchParamsToObject(new URLSearchParams(searchParamsKey));
        return options.validateSearch ? options.validateSearch(raw) : raw;
      }, [searchParamsKey]);
    },
    useParams() {
      const context = useContext(RouteCompatContext);
      const nextParams = useNextParams();
      return (context.params ?? nextParams) as any;
    },
    useLoaderData() {
      return useContext(RouteCompatContext).loaderData as any;
    },
    useRouteContext() {
      return (useContext(RouteCompatContext).routeContext ?? {}) as any;
    },
  } satisfies CompatRoute;

  return route;
}

export function createFileRoute(path: string) {
  return (options: RouteOptions) => createCompatRoute(path, options);
}

export function createRootRouteWithContext<TContext extends Record<string, unknown>>() {
  return (options: RouteOptions) =>
    createCompatRoute("/", options) as CompatRoute & {
      useRouteContext: () => TContext;
    };
}

function buildHref({
  to,
  params,
  search,
}: {
  to?: string;
  params?: ParamsRecord;
  search?: SearchRecord;
}) {
  let href = to ?? "/";

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      const paramValue = Array.isArray(value) ? value.join("/") : value;
      if (paramValue == null) continue;
      href = href.replace(`$${key}`, encodeURIComponent(paramValue));
      href = href.replace(`[${key}]`, encodeURIComponent(paramValue));
    }
  }

  const url = new URL(href, "http://immojudis.local");
  if (search) {
    for (const [key, value] of Object.entries(search)) {
      if (value == null || value === "") {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return `${url.pathname}${url.search}`;
}

type CompatLinkProps = Omit<React.ComponentProps<typeof NextLink>, "href"> & {
  href?: string;
  to?: string;
  params?: ParamsRecord;
  search?: SearchRecord;
  activeOptions?: { exact?: boolean };
  activeProps?: { className?: string };
};

export function Link({
  href,
  to,
  params,
  search,
  activeOptions,
  activeProps,
  className,
  ...props
}: CompatLinkProps) {
  const pathname = usePathname();
  const resolvedHref = href ?? buildHref({ to, params, search });
  const resolvedPath = resolvedHref.split("?")[0] || "/";
  const isActive = activeOptions?.exact
    ? pathname === resolvedPath
    : pathname === resolvedPath || pathname.startsWith(`${resolvedPath}/`);
  const resolvedClassName = [className, isActive ? activeProps?.className : undefined]
    .filter(Boolean)
    .join(" ");

  return <NextLink href={resolvedHref} className={resolvedClassName || undefined} {...props} />;
}

type NavigateOptions = {
  to?: string;
  params?: ParamsRecord;
  search?: SearchRecord | ((previous: SearchRecord) => SearchRecord);
  replace?: boolean;
};

export function useNavigate(_options?: unknown) {
  const router = useNextRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const searchParamsKeyRef = useRef(searchParamsKey);

  useEffect(() => {
    searchParamsKeyRef.current = searchParamsKey;
  }, [searchParamsKey]);

  return useCallback(
    (options: string | NavigateOptions) => {
      if (typeof options === "string") {
        router.push(options);
        return;
      }

      const previous = searchParamsToObject(new URLSearchParams(searchParamsKeyRef.current));
      const nextSearch =
        typeof options.search === "function" ? options.search(previous) : options.search;
      const href = buildHref({
        to: options.to ?? pathname,
        params: options.params,
        search: nextSearch,
      });

      if (options.replace) {
        router.replace(href);
      } else {
        router.push(href);
      }
    },
    [pathname, router],
  );
}

export function useLocation() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  return {
    pathname,
    search: search ? `?${search}` : "",
    href: `${pathname}${search ? `?${search}` : ""}`,
  };
}

export function useSearch(_options?: unknown) {
  const searchParams = useSearchParams();
  const searchParamsKey = searchParams.toString();
  return useMemo(
    () => searchParamsToObject(new URLSearchParams(searchParamsKey)),
    [searchParamsKey],
  );
}

export function useRouter() {
  const router = useNextRouter();
  return {
    invalidate: () => router.refresh(),
    refresh: () => router.refresh(),
    push: router.push,
    replace: router.replace,
    back: router.back,
  };
}

export function Navigate({ to, search, params, replace }: NavigateOptions) {
  const navigate = useNavigate();

  useEffect(() => {
    navigate({ to, search, params, replace });
  }, [navigate, params, replace, search, to]);

  return null;
}

export function Outlet() {
  return null;
}

export function HeadContent() {
  return null;
}

export function Scripts() {
  return null;
}

export function redirect(options: { to: string; replace?: boolean } | string) {
  nextRedirect(typeof options === "string" ? options : options.to);
}

export function notFound() {
  nextNotFound();
}
