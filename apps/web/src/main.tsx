import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BrowserRouter } from "./routing/Router";
import { AuthProvider } from "./state/AuthContext";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("RafayPair root element is missing.");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
