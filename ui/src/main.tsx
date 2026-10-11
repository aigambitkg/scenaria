import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/instrument-sans";
import "@fontsource/stix-two-text/400-italic.css";
import "@fontsource/stix-two-text/500-italic.css";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import type { SessionKeys } from "./Control";

/** Keeps the session keys (memory only) across project switches; a switch remounts the dashboard. */
function Shell() {
  const [keys, setKeys] = useState<SessionKeys>({});
  const [project, setProject] = useState(0);
  return <App key={project} keys={keys} setKeys={setKeys} onProjectSwitched={() => setProject((n) => n + 1)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <Shell />
    </ErrorBoundary>
  </StrictMode>,
);
