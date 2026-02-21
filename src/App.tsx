import { ReclaimDashboard } from './ReclaimDashboard';

// accessibility-focused app wrapper
export default function App() {
  return (
    <div className="min-h-screen bg-skitty-cream font-body text-skitty-black antialiased">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4 z-50 bg-white px-4 py-2 rounded-md shadow-md text-skitty-dark focus:outline-none focus:ring-2 focus:ring-skitty-coral">
        Skip to main content
      </a>
      <div id="main-content" tabIndex={-1}>
        <ReclaimDashboard />
      </div>
    </div>
  );
}
