import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { DataProvider } from './lib/data';
import { ThemeProvider } from './lib/theme';
import './index.css';

// Every palette in src/themes, pulled in by glob rather than by a list of
// imports, so that adding a theme is adding ONE file - the same promise
// lib/themes.ts makes and checks/theme-contract.mjs enforces. An import list
// here would be a third place to remember, and the failure would be a theme
// that appears in the picker and changes nothing when chosen.
//
// Order does not matter: every theme block doubles its attribute selector to
// score 0,3,0, which beats the base palettes from anywhere in the bundle. That
// is deliberate, because Vite hoists and rewrites @import and betting on
// emission order would be betting on a build detail.
import.meta.glob('./themes/*.css', { eager: true });

// HashRouter (not BrowserRouter): the app is served as static files by nginx
// with no client-routing rewrite, so deep links must live after the '#'.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <ThemeProvider>
        <DataProvider>
          <App />
        </DataProvider>
      </ThemeProvider>
    </HashRouter>
  </StrictMode>,
);
