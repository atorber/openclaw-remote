import path from "node:path";
import { defineConfig } from "vite";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";

export default defineConfig({
  root: path.resolve(__dirname, "src"),
  publicDir: false,
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: path.resolve(__dirname, "src/popup/popup.html"),
      },
      output: {
        entryFileNames: "[name]/[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name]/[name][extname]",
      },
    },
  },
  plugins: [
    {
      name: "copy-manifest",
      closeBundle() {
        const out = path.resolve(__dirname, "dist");
        if (!existsSync(out)) mkdirSync(out, { recursive: true });
        copyFileSync(
          path.resolve(__dirname, "manifest.json"),
          path.join(out, "manifest.json"),
        );
      },
    },
  ],
});
