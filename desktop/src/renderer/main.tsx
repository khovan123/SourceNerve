import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./design-system.css";
import "./styles.css";
import "./onboarding.css";
import "./workspace-manager.css";
import "./connections.css";
import "./overview.css";
import "./settings.css";
import "./diagnostics.css";
import "./intelligence.css";
import "./tasks.css";
import "./provider-workflow.css";
import "./plugin-verification.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("SourceNerve Desktop root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
