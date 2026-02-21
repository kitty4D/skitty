/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Inter"', 'system-ui', 'sans-serif'],
        body: ['"Inter"', 'system-ui', 'sans-serif'],
      },
      colors: {
        skitty: {
          bg: '#000000',
          card: '#0a0a0a',
          border: '#1a1a1a',
          accent: '#a855f7', // vibrant purple
          primary: '#ffffff',
          secondary: '#94a3b8',
          success: '#22c55e',
          warning: '#f59e0b',
          error: '#ef4444',
          // legacy keys so we don't break if we miss some
          cream: '#000000',
          peach: '#1a1a1a',
          coral: '#a855f7',
          brown: '#94a3b8',
          dark: '#ffffff',
          black: '#ffffff',
        },
      },
      borderRadius: {
        'skitty': '0px',
        'skitty-lg': '0px',
      },
      boxShadow: {
        'skitty': '4px 4px 0px rgba(168, 85, 247, 0.2)',
        'skitty-hover': '8px 8px 0px rgba(168, 85, 247, 0.3)',
        'brutal': '4px 4px 0px #000000',
        'brutal-accent': '4px 4px 0px #a855f7',
      },
      borderWidth: {
        '3': '3px',
      }
    },
  },
  plugins: [require("tailwindcss-animate")],
};
