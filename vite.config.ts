import { defineConfig } from "vite";

// Repo is served from https://twigotter.github.io/wheredl/, so asset URLs
// need the repo name as a base path (GitHub Pages project sites aren't
// served from the domain root).
export default defineConfig({
  base: "/wheredl/",
});
