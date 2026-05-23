import { defineConfig } from 'vite';

export default defineConfig({
  base: './' // Ensures assets load correctly relative to the subfolder hosting (/rebrew/) on GitHub Pages
});
