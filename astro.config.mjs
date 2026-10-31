// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import markdoc from '@astrojs/markdoc';
import keystatic from '@keystatic/astro';

// The Keystatic admin UI needs a server, so it only runs under `astro dev`.
// Production builds are fully static for GitHub Pages.
const isDev = process.argv.includes('dev');

// https://astro.build/config
export default defineConfig({
  // Set by the GitHub Pages workflow; e.g. https://user.github.io + /repo-name
  site: process.env.SITE_URL,
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'ignore',
  integrations: [react(), markdoc(), ...(isDev ? [keystatic()] : [])],
});
