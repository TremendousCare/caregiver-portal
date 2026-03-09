import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Strip .ts extensions from imports so Node/Vitest can resolve Deno-style paths
    // e.g., import { X } from "../constants.ts" → resolves "../constants"
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
