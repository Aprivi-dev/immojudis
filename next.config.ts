import type { NextConfig } from "next";

const propertyDemoEnabled = process.env.ENABLE_PROPERTY_DEMO === "true";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: process.cwd(),
  },
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_OSM_TILE_URL:
      process.env.NEXT_PUBLIC_OSM_TILE_URL ??
      process.env.NEXT_PUBLIC_OSM_TILE_TEMPLATE ??
      process.env.VITE_OSM_TILE_URL ??
      process.env.VITE_OSM_TILE_TEMPLATE,
    NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN:
      process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN ?? process.env.VITE_MAPBOX_ACCESS_TOKEN,
    NEXT_PUBLIC_MAPBOX_STYLE:
      process.env.NEXT_PUBLIC_MAPBOX_STYLE ??
      process.env.NEXT_PUBLIC_MAPBOX_STYLE_ID ??
      process.env.VITE_MAPBOX_STYLE ??
      process.env.VITE_MAPBOX_STYLE_ID,
  },
  async redirects() {
    if (propertyDemoEnabled) {
      return [];
    }

    return [
      {
        source: "/properties",
        destination: "/annonce-exemple",
        permanent: false,
      },
      {
        source: "/properties/:path*",
        destination: "/annonce-exemple",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
