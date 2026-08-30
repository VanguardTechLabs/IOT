/**
 * The web panel's palette, restated for React Native.
 *
 * Deliberately not a theming library: the app is dark-only, matching the panel,
 * and a token object costs nothing while a provider would have to be threaded
 * through every screen for a choice nobody is offering.
 */
export const c = {
  bg: '#0b1220',
  surface: '#111c30',
  surfaceAlt: '#16233b',
  border: '#1f2f4a',
  text: '#e2e8f0',
  textDim: '#94a3b8',
  textFaint: '#64748b',
  accent: '#22d3ee',
  accentDim: '#0e7490',
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f87171',
} as const;

export const radius = { sm: 8, md: 12, lg: 16 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
