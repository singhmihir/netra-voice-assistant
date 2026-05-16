/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: '#1a56db',
        'primary-dark': '#1e429f',
        success: '#057a55',
        danger: '#c81e1e',
        warning: '#c27803',
      },
      fontSize: {
        'accessible-base': ['1.125rem', { lineHeight: '1.75rem' }],
        'accessible-lg': ['1.25rem', { lineHeight: '1.875rem' }],
        'accessible-xl': ['1.5rem', { lineHeight: '2rem' }],
        'accessible-2xl': ['2rem', { lineHeight: '2.5rem' }],
      }
    },
  },
  plugins: [],
}
