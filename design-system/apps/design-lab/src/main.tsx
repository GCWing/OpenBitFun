import React from "react";
import ReactDOM from "react-dom/client";
import "@openbitfun/theme-openbitfun/default.css";
import "@openbitfun/ui/styles.css";
import "@openbitfun/ui/mobile.css";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import "./styles.css";
import "./design-layout.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Design Lab root element was not found.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
