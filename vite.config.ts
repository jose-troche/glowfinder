import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const ARTIFACTS = resolve(import.meta.dirname, "data/artifacts");

/** The pipeline's committed artifacts are served at /artifacts, in dev and in the build. */
function artifacts(): Plugin {
  return {
    name: "glowfinder-artifacts",
    configureServer(server) {
      server.middlewares.use("/artifacts", (req, res, next) => {
        const file = join(ARTIFACTS, decodeURIComponent((req.url ?? "/").split("?")[0]!));
        if (!file.startsWith(ARTIFACTS) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(res);
      });
    },
    writeBundle(options) {
      cpSync(ARTIFACTS, join(options.dir!, "artifacts"), { recursive: true });
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [artifacts()],
  build: {
    outDir: "public",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 6000, // Mol* is one large, lazily loaded chunk
  },
  server: {
    // `npm run dev` + `wrangler dev` side by side: the Worker answers /api/*
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
