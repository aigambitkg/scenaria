/**
 * Never a blank page: a render error shows what happened and a way back, instead of unmounting the app.
 * Used around the whole app and around the side panel and dialogs (so one broken part keeps the rest usable).
 */
import { Component, type ReactNode } from "react";

const TEXT = {
  de: { title: "Hier ist etwas schiefgelaufen", hint: "Dieser Teil des Dashboards ist abgestürzt – deine Daten sind nicht betroffen.", retry: "Erneut versuchen", reload: "Seite neu laden", translate: "Tipp: Ist die automatische Übersetzung des Browsers für diese Seite an? Bitte ausschalten – sie verändert die Seite und bringt das Dashboard zum Absturz." },
  en: { title: "Something went wrong here", hint: "This part of the dashboard crashed — your data is not affected.", retry: "Try again", reload: "Reload page", translate: "Tip: is the browser's automatic translation on for this page? Please turn it off — it changes the page and crashes the dashboard." },
};

function lang(): "de" | "en" {
  try {
    return (localStorage.getItem("scenaria.lang") ?? document.documentElement.lang ?? navigator.language).startsWith("de") ? "de" : "en";
  } catch {
    return "en";
  }
}

export class ErrorBoundary extends Component<{ scope: string; children: ReactNode; onReset?: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[scenaria] ${this.props.scope} crashed:`, error);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const t = TEXT[lang()];
    const translation = /removeChild|insertBefore|not a child of this node/i.test(String(error?.message));
    return (
      <div className={`crash ${this.props.scope === "app" ? "crash-app" : ""}`} role="alert">
        <strong>{t.title}</strong>
        <p>{t.hint}</p>
        {translation && <p className="crash-tip">{t.translate}</p>}
        <pre>{String(error?.message ?? error).slice(0, 400)}</pre>
        <div className="crash-actions">
          <button
            className="btn primary"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset?.();
            }}
          >
            {t.retry}
          </button>
          <button className="btn" onClick={() => location.reload()}>
            {t.reload}
          </button>
        </div>
      </div>
    );
  }
}
