import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../..",
  plugins: [sveltekit()],
  server: {
    port: 5173,
    strictPort: false
  }
});
