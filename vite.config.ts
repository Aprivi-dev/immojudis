// @lovable.dev/vite-tanstack-config is still used as the TanStack/Vite plugin
// wrapper. Legacy Lovable project metadata is not used by Immojudis.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { nitro } from "nitro/vite";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
export default defineConfig({
  // Keep the optional Cloudflare integration disabled: Vercel is the deployment target.
  cloudflare: false,
  vite: {
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes("node_modules")) return;
            if (id.includes("@supabase/")) return "vendor-supabase";
            if (id.includes("@radix-ui/")) return "vendor-radix";
            if (id.includes("leaflet")) return "vendor-leaflet";
            if (id.includes("lucide-react")) return "vendor-icons";
          },
        },
      },
    },
  },
  plugins: [nitro()],
  tanstackStart: {
    server: { entry: "server" },
  },
});
