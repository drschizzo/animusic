import { defineConfig } from 'vite';

export default defineConfig({
  // Chemins relatifs : l'appli fonctionne servie depuis https://<user>.github.io/<repo>/
  base: './',
  build: { chunkSizeWarningLimit: 2000 },
});
