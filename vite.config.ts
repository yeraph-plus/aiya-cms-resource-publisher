import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 5173,
        // Fail loudly instead of silently drifting to 5174+: the dev setup
        // and the proxy assume exactly this port. A squatter here is either
        // evicted by scripts/dev.mjs (our own stale Vite) or is someone
        // else's and must be resolved by hand.
        strictPort: true,
        proxy: {
            // 127.0.0.1, not localhost: the API server binds IPv4 only, and a
            // localhost target can resolve to ::1 first on Windows.
            "/api": "http://127.0.0.1:5175",
        },
    },
});
