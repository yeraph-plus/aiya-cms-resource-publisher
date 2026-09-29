import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        port: 5173,
        proxy: {
            // 127.0.0.1, not localhost: the API server binds IPv4 only, and a
            // localhost target can resolve to ::1 first on Windows.
            "/api": "http://127.0.0.1:5175",
        },
    },
});
