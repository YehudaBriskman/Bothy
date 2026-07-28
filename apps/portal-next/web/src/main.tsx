import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { DataProvider } from './lib/data';
import { ThemeProvider } from './lib/theme';
import './index.css';

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
