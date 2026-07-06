import React, { useState } from "react";
import { Check, ChevronDown, ChevronRight, Code, Copy, MessageSquarePlus, Square } from "lucide-react";
import type { DiffFileSummary } from "../../shared/types";

export function HeaderCollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle(): void }): React.JSX.Element {
  return (
    <button
      className="headerCollapseToggle"
      title={collapsed ? "Expand file" : "Collapse file"}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
    </button>
  );
}

export function HeaderMetadata({
  file,
  viewed,
  changedSinceViewed,
  onToggleViewed,
  onOpenInEditor,
  onAddFileComment,
}: {
  file?: DiffFileSummary;
  viewed: boolean;
  changedSinceViewed: boolean;
  onToggleViewed(): void;
  onOpenInEditor(): void;
  onAddFileComment(): void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copyPath = async (): Promise<void> => {
    if (!file) return;
    await navigator.clipboard.writeText(file.path);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 900);
  };

  return (
    <div className="headerMetadata" onClick={(event) => event.stopPropagation()}>
      {file?.previousPath && <span className="renamedMeta">from {file.previousPath}</span>}
      {file?.isGenerated && <span className="fileBadge" title={file.generatedReason}>generated</span>}
      {changedSinceViewed && <span className="fileBadge updated">updated</span>}
      <button type="button" title="Copy file path" onClick={() => void copyPath()}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <button type="button" title="Comment on file" onClick={onAddFileComment}>
        <MessageSquarePlus size={14} />
      </button>
      <button type="button" title="Open in editor" onClick={onOpenInEditor}>
        <Code size={14} />
      </button>
      <button type="button" title={viewed ? "Mark unviewed" : "Mark viewed"} onClick={onToggleViewed}>
        {viewed ? <Check size={14} /> : <Square size={14} />}
        Viewed
      </button>
    </div>
  );
}
