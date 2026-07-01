import type { NextConfig } from "next";

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
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY:
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? process.env.VITE_GOOGLE_MAPS_API_KEY,
    NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID:
      process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? process.env.VITE_GOOGLE_MAPS_MAP_ID,
  },
};

export default nextConfig;
