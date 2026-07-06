import React from "react";
import { RefreshCw, X } from "lucide-react";
import type { LoadState } from "../types";

export function FloatingPanel({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }): React.JSX.Element {
  return (
    <section className="floatingPanel">
      <header>
        <strong>{title}</strong>
        <button title="Close" onClick={onClose}><X size={15} /></button>
      </header>
      {children}
    </section>
  );
}

export function StateBanner({ state, onRetry }: { state: LoadState; onRetry(): void }): React.JSX.Element {
  if (state.status === "idle") return <div className="stateBanner">Ready.</div>;
  if (state.status === "ready") return <></>;
  return (
    <div className={`stateBanner ${state.status}`}>
      <div>
        <strong>{state.status === "loading" ? "Loading diff" : state.status === "empty" ? "No changes" : "Could not load diff"}</strong>
        <p>{state.message}</p>
      </div>
      {state.status !== "loading" && <button onClick={onRetry}><RefreshCw size={15} /> Retry</button>}
    </div>
  );
}
