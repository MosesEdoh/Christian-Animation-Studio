/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    text: '#242338',
    tint: '#f2cf51',
    background: '#f4f0e8',
    foreground: '#242338',
    card: '#fcf9f3',
    cardForeground: '#242338',
    primary: '#242338',
    primaryForeground: '#fcf9f3',
    secondary: '#e7dfd1',
    secondaryForeground: '#242338',
    muted: '#e9e4d9',
    mutedForeground: '#686879',
    accent: '#f2cf51',
    accentForeground: '#242338',
    destructive: '#d95850',
    destructiveForeground: '#ffffff',
    border: '#d9d1c3',
    input: '#d9d1c3',
    teal: '#478f8b',
    coral: '#d95850',
  },
  dark: {
    text: '#f7f2e9',
    tint: '#f2cf51',
    background: '#171829',
    foreground: '#f7f2e9',
    card: '#222439',
    cardForeground: '#f7f2e9',
    primary: '#f2cf51',
    primaryForeground: '#242338',
    secondary: '#303147',
    secondaryForeground: '#f7f2e9',
    muted: '#303147',
    mutedForeground: '#b8b7c6',
    accent: '#f2cf51',
    accentForeground: '#242338',
    destructive: '#e36a60',
    destructiveForeground: '#ffffff',
    border: '#393b50',
    input: '#393b50',
    teal: '#70b8b2',
    coral: '#e36a60',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 12,
};

export default colors;
