import React, { useEffect, useState } from "react";
import { Edit2, MessageSquareReply, Trash2 } from "lucide-react";
import type { ReviewFinding } from "../../shared/types";
import { splitSuggestionBlocks } from "../lib/reviewFormat";

export function ReviewAnnotation({
  finding,
  outdated,
  onDelete,
  onToggle,
  onUpdateComment,
  onReply,
  onDeleteReply,
  onEditingChange,
}: {
  finding: ReviewFinding;
  outdated: boolean;
  onDelete(id: string): void;
  onToggle(id: string): void;
  onUpdateComment(id: string, comment: string): void;
  onReply(id: string, body: string): void;
  onDeleteReply(findingId: string, replyId: string): void;
  onEditingChange(id: string, editing: boolean): void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draftComment, setDraftComment] = useState(finding.comment);
  const [reply, setReply] = useState("");

  useEffect(() => () => onEditingChange(finding.id, false), [finding.id, onEditingChange]);
  useEffect(() => {
    if (!editing) setDraftComment(finding.comment);
  }, [editing, finding.comment]);

  const setEditingState = (nextEditing: boolean): void => {
    setEditing(nextEditing);
    onEditingChange(finding.id, nextEditing);
  };

  const saveEdit = (): void => {
    onUpdateComment(finding.id, draftComment.trim());
    setEditingState(false);
  };
  const submitReply = (): void => {
    if (!reply.trim()) return;
    onReply(finding.id, reply);
    setReply("");
  };

  return (
    <div className="inlineAnnotation">
      <header>
        <strong>{finding.status === "open" ? "Open" : "Resolved"} - {finding.author} {outdated && <span className="inlineBadge">outdated</span>}</strong>
        <div>
          <button title="Edit comment" onClick={() => setEditingState(!editing)}><Edit2 size={14} /></button>
          <button onClick={() => onToggle(finding.id)}>{finding.status === "open" ? "Resolve" : "Reopen"}</button>
          <button title="Delete comment" onClick={() => onDelete(finding.id)}><Trash2 size={14} /></button>
        </div>
      </header>
      {editing ? (
        <div className="threadEditor">
          <textarea value={draftComment} onChange={(event) => setDraftComment(event.target.value)} />
          <div>
            <button onClick={() => {
              setDraftComment(finding.comment);
              setEditingState(false);
            }}>Cancel</button>
            <button className="primary" onClick={saveEdit} disabled={!draftComment.trim()}>Save</button>
          </div>
        </div>
      ) : (
        <CommentBody body={finding.comment} selectedCode={finding.selectedCode} />
      )}
      {finding.replies.length > 0 && (
        <div className="replyList">
          {finding.replies.map((reply) => (
            <div key={reply.id} className="replyItem">
              <p><strong>{reply.author}</strong>: {reply.body}</p>
              <button title="Delete reply" onClick={() => onDeleteReply(finding.id, reply.id)}><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="replyComposer">
        <textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Reply" />
        <button onClick={submitReply} disabled={!reply.trim()}><MessageSquareReply size={14} /> Reply</button>
      </div>
    </div>
  );
}

function CommentBody({ body, selectedCode }: { body: string; selectedCode?: string }): React.JSX.Element {
  const parts = splitSuggestionBlocks(body);
  return (
    <div className="commentBody">
      {parts.map((part, index) =>
        part.kind === "suggestion" ? (
          <div key={index} className="suggestionBlock">
            {selectedCode && <pre className="suggestionOriginal">{selectedCode}</pre>}
            <pre className="suggestionNext">{part.code}</pre>
          </div>
        ) : (
          <p key={index}>{part.text || "\u00a0"}</p>
        ),
      )}
    </div>
  );
}
