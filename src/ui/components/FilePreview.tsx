import React, { useEffect, useState } from "react";
import { FileText, Image } from "lucide-react";
import type { DiffFileSummary } from "../../shared/types";
import type { PreviewRefs } from "../types";
import { blobUrl, getPreviewKind } from "../lib/preview";

export function FilePreview({ file, refs }: { file: DiffFileSummary; refs: PreviewRefs }): React.JSX.Element | null {
  const kind = getPreviewKind(file.path);
  if (!kind) return null;
  if (kind === "image") return <ImagePreview file={file} refs={refs} />;
  return <TextPreview file={file} refs={refs} kind={kind} />;
}

function ImagePreview({ file, refs }: { file: DiffFileSummary; refs: PreviewRefs }): React.JSX.Element {
  const baseUrl = refs.baseRef && file.status !== "added" ? blobUrl(file.path, refs.baseRef) : "";
  const targetUrl = refs.targetRef && file.status !== "deleted" ? blobUrl(file.path, refs.targetRef) : "";
  return (
    <section className="filePreview imagePreview">
      <header><Image size={15} /> Image preview</header>
      <div className="previewGrid">
        {baseUrl && <figure><figcaption>base</figcaption><img src={baseUrl} alt={`${file.path} base`} /></figure>}
        {targetUrl && <figure><figcaption>target</figcaption><img src={targetUrl} alt={`${file.path} target`} /></figure>}
      </div>
    </section>
  );
}

function TextPreview({ file, refs, kind }: { file: DiffFileSummary; refs: PreviewRefs; kind: "markdown" | "notebook" }): React.JSX.Element {
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const ref = file.status === "deleted" ? refs.baseRef : refs.targetRef;

  useEffect(() => {
    if (!ref) return;
    let cancelled = false;
    fetch(blobUrl(file.path, ref))
      .then((response) => {
        if (!response.ok) throw new Error(response.statusText);
        return response.text();
      })
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setError("");
        }
      })
      .catch((fetchError) => {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : "preview failed");
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, ref]);

  return (
    <section className="filePreview textPreview">
      <header><FileText size={15} /> {kind === "markdown" ? "Markdown preview" : "Notebook preview"}</header>
      {error ? <p className="emptyText">{error}</p> : kind === "markdown" ? <MarkdownPreview content={content} /> : <NotebookPreview content={content} />}
    </section>
  );
}

function MarkdownPreview({ content }: { content: string }): React.JSX.Element {
  const lines = content.split("\n").slice(0, 160);
  return (
    <div className="markdownPreview">
      {lines.map((line, index) => {
        const heading = /^(#{1,4})\s+(.*)$/.exec(line);
        if (heading) {
          const Tag = `h${Math.min(heading[1].length + 2, 6)}` as keyof React.JSX.IntrinsicElements;
          return <Tag key={index}>{heading[2]}</Tag>;
        }
        if (/^\s*[-*]\s+/.test(line)) return <p key={index} className="markdownBullet">{line.replace(/^\s*[-*]\s+/, "")}</p>;
        if (line.trim() === "") return <br key={index} />;
        return <p key={index}>{line}</p>;
      })}
    </div>
  );
}

function NotebookPreview({ content }: { content: string }): React.JSX.Element {
  try {
    const notebook = JSON.parse(content) as { cells?: Array<{ cell_type?: string; source?: string[] | string }> };
    const cells = notebook.cells?.slice(0, 24) ?? [];
    return (
      <div className="notebookPreview">
        {cells.map((cell, index) => (
          <article key={index}>
            <strong>{cell.cell_type ?? "cell"}</strong>
            <pre>{Array.isArray(cell.source) ? cell.source.join("") : cell.source ?? ""}</pre>
          </article>
        ))}
      </div>
    );
  } catch {
    return <p className="emptyText">Notebook preview is unavailable for invalid JSON.</p>;
  }
}
