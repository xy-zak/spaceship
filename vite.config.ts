import { readdirSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig } from "vite"
import { turns } from "./server/turns.mjs"

const OLLAMA = `http://127.0.0.1:${process.env.OLLAMA_PORT ?? 11434}` // another port lets the simulation's mock run beside a real Ollama

export default defineConfig({
  base: "/spaceship/",
  appType: "mpa", // a missing view.html returns 404 instead of index.html, which would loop page swaps
  plugins: [turns({ file: resolve(import.meta.dirname, "data/manifesto.json") })],
  server: {
    allowedHosts: ["pa.local"], // Vite returns 403 for any hostname except localhost and IPs
    proxy: {
      "/ollama/v1/chat/completions": {
        target: OLLAMA,
        changeOrigin: true,
        headers: { origin: OLLAMA }, // Ollama returns 403 for Origins it doesn't know
        rewrite: (path) => path.slice("/ollama".length),
      },
    },
  },
  preview: { host: true, strictPort: true }, // proxy and allowedHosts carry over from server
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        view: resolve(import.meta.dirname, "view.html"),
        ...Object.fromEntries(
          readdirSync(resolve(import.meta.dirname, "extra"))
            .filter((file) => file.endsWith(".html"))
            .map((file) => [`extra/${file.slice(0, -".html".length)}`, resolve(import.meta.dirname, "extra", file)]),
        ),
      },
    },
  },
})
