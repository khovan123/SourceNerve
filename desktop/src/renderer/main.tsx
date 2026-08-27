import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { HarnessJobMonitor } from "./components/HarnessJobMonitor";
import "./design-system.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("SourceNerve Desktop root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <HarnessJobMonitor />
    <App />
  </StrictMode>,
);
