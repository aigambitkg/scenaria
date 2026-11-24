import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/instrument-sans";
import "@fontsource/stix-two-text/400-italic.css";
import "@fontsource/stix-two-text/500-italic.css";
import "../../ui/src/styles.css";
import "./site.css";
import { Landing } from "./Landing";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
