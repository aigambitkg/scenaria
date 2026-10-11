/** The "?" button: opens the help at a topic from anywhere (no props plumbing). */
import { createContext, useContext } from "react";

/** Opens the help at a topic from anywhere (dialogs need no extra props). */
export const HelpContext = createContext<{ open: (topic: string) => void; label: string }>({ open: () => {}, label: "Help" });

/** A small "?" that opens the help at a topic. */
export function HelpButton({ topic }: { topic: string }) {
  const h = useContext(HelpContext);
  return (
    <button
      type="button"
      className="btn icon help-q"
      title={h.label}
      aria-label={`${h.label}: ${topic}`}
      onClick={(e) => {
        e.stopPropagation();
        h.open(topic);
      }}
    >
      ?
    </button>
  );
}

