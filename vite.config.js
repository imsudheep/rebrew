import { defineConfig } from 'vite';

export default defineConfig(({ command }) => {
  return {
    // Dynamic Base Path: '/' for local development, '/rebrew/' for GitHub Pages production
    base: command === 'build' ? '/rebrew/' : '/'
  };
});
