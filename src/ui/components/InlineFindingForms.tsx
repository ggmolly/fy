import React from "react";
import { Code, FileCheck2, MessageSquarePlus, X } from "lucide-react";
import type { DiffFileSummary } from "../../shared/types";
import type { CodeViewLineSelection } from "../types";
import { formatSelectionLabel } from "../lib/selection";

export function InlineFindingForm({
  draft,
  selectedLines,
  selectedCode,
  onChange,
  onClose,
  onSubmit,
}: {
  draft: { comment: string };
  selectedLines: CodeViewLineSelection;
  selectedCode?: string;
  onChange(next: { comment: string }): void;
  onClose(): void;
  onSubmit(): void;
}): React.JSX.Element {
  const insertSuggestion = (): void => {
    const block = ["```suggestion", selectedCode ?? "", "```"].join("\n");
    onChange({ ...draft, comment: draft.comment.trim() ? `${draft.comment.trim()}\n\n${block}` : block });
  };
  const submitOnModEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey) || !draft.comment.trim()) return;
    event.preventDefault();
    onSubmit();
  };

  return (
    <section className="inlineDraft">
      <header>
        <div>
          <MessageSquarePlus size={16} />
          <strong>Add a finding on {formatSelectionLabel(selectedLines)}</strong>
        </div>
        <button title="Close" onClick={onClose}><X size={15} /></button>
      </header>
      <p className="selectionMeta">{selectedLines.id}</p>
      <textarea
        autoFocus
        value={draft.comment}
        onChange={(event) => onChange({ ...draft, comment: event.target.value })}
        onKeyDown={submitOnModEnter}
        placeholder="Finding comment"
      />
      <footer>
        <button onClick={insertSuggestion} disabled={!selectedCode?.trim()}><Code size={15} /> Suggestion</button>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={onSubmit} disabled={!draft.comment.trim()}>
          <FileCheck2 size={15} />
          Add finding
        </button>
      </footer>
    </section>
  );
}

export function InlineFileFindingForm({
  file,
  value,
  onChange,
  onClose,
  onSubmit,
}: {
  file: DiffFileSummary;
  value: string;
  onChange(next: string): void;
  onClose(): void;
  onSubmit(): void;
}): React.JSX.Element {
  const submitOnModEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey) || !value.trim()) return;
    event.preventDefault();
    onSubmit();
  };

  return (
    <section className="inlineDraft">
      <header>
        <div>
          <MessageSquarePlus size={16} />
          <strong>Add a finding on this file</strong>
        </div>
        <button title="Close" onClick={onClose}><X size={15} /></button>
      </header>
      <p className="selectionMeta">{file.path}</p>
      <textarea
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={submitOnModEnter}
        placeholder="File-level finding comment"
      />
      <footer>
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={onSubmit} disabled={!value.trim()}>
          <FileCheck2 size={15} />
          Add finding
        </button>
      </footer>
    </section>
  );
}
