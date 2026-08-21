import React, { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Search,
} from "lucide-react";
import type { DiffFileSummary } from "../../shared/types";
import type { SidebarFilter } from "../types";

export function FileList({
  files,
  viewedFiles,
  changedSinceViewedFiles,
  commentCounts,
  activeFile,
  onSelect,
  onToggleViewed,
  onToggleFolderViewed,
}: {
  files: DiffFileSummary[];
  viewedFiles: Set<string>;
  changedSinceViewedFiles: Set<string>;
  commentCounts: Map<string, number>;
  activeFile: string;
  onSelect(path: string): void;
  onToggleViewed(path: string): void;
  onToggleFolderViewed(path: string, viewed: boolean): void;
}): React.JSX.Element {
  const [filter, setFilter] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<SidebarFilter>>(new Set());
  const filteredFiles = useMemo(
    () => files.filter((file) => matchesSidebarFilters(file, filter, activeFilters, viewedFiles, changedSinceViewedFiles, commentCounts)),
    [activeFilters, changedSinceViewedFiles, commentCounts, files, filter, viewedFiles],
  );
  const tree = useMemo(() => buildFileTree(filteredFiles), [filteredFiles]);
  const allDirs = useMemo(() => collectFolderPaths(tree), [tree]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set(allDirs));

  useEffect(() => {
    setExpandedDirs((current) => new Set([...current, ...allDirs]));
  }, [allDirs]);

  const visibleFiles = useMemo(() => new Set(tree.files.map((file) => file.path)), [tree.files]);
  const shownViewedCount = tree.files.filter((file) => viewedFiles.has(file.path)).length;

  return (
    <div className="fileTreePanel">
      <label className="fileSearch">
        <Search size={14} />
        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter files" />
      </label>
      <div className="fileFilterBar">
        {(["open", "viewed", "updated", "comments", "generated"] satisfies SidebarFilter[]).map((name) => (
          <button
            key={name}
            className={activeFilters.has(name) ? "active" : ""}
            onClick={() =>
              setActiveFilters((current) => {
                const next = new Set(current);
                if (next.has(name)) next.delete(name);
                else next.add(name);
                return next;
              })
            }
          >
            {name}
          </button>
        ))}
      </div>
      <div className="fileTreeToolbar">
        <span>{shownViewedCount}/{tree.files.length} viewed</span>
        <div>
          <button title="Expand folders" onClick={() => setExpandedDirs(new Set(allDirs))}><ChevronsUpDown size={14} /></button>
          <button title="Collapse folders" onClick={() => setExpandedDirs(new Set())}><ChevronsDownUp size={14} /></button>
        </div>
      </div>
      <div className="fileList">
        {tree.nodes.length === 0 && <p className="emptyText">No changed files match this filter.</p>}
        {tree.nodes.map((node) => (
          <FileTreeNode
            key={node.path}
            node={node}
            depth={0}
            expandedDirs={expandedDirs}
            viewedFiles={viewedFiles}
            changedSinceViewedFiles={changedSinceViewedFiles}
            commentCounts={commentCounts}
            activeFile={activeFile}
            visibleFiles={visibleFiles}
            onSelect={onSelect}
            onToggleViewed={onToggleViewed}
            onToggleFolderViewed={onToggleFolderViewed}
            onToggleDir={(path) =>
              setExpandedDirs((current) => {
                const next = new Set(current);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

export function ReviewProgress({ progress }: { progress: { files: number; viewed: number; openComments: number; outdatedComments: number; updatedFiles: number } }): React.JSX.Element {
  const percent = progress.files === 0 ? 0 : Math.round((progress.viewed / progress.files) * 100);
  return (
    <section className="reviewProgress">
      <div>
        <strong>{progress.viewed}/{progress.files}</strong>
        <span>viewed</span>
      </div>
      <div>
        <strong>{progress.openComments}</strong>
        <span>open</span>
      </div>
      <div>
        <strong>{progress.updatedFiles}</strong>
        <span>updated</span>
      </div>
      <div>
        <strong>{progress.outdatedComments}</strong>
        <span>outdated</span>
      </div>
      <div className="progressTrack"><span style={{ width: `${percent}%` }} /></div>
    </section>
  );
}

export function AutoViewRulesEditor({
  value,
  onChange,
  onSave,
}: {
  value: string;
  onChange(next: string): void;
  onSave(): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <section className="autoRules">
      <button className="autoRulesToggle" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Auto-view rules
      </button>
      {open && (
        <div className="autoRulesEditor">
          <textarea value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
          <button onClick={onSave}>Save rules</button>
        </div>
      )}
    </section>
  );
}

type FileTreeNode =
  | { kind: "file"; path: string; name: string; file: DiffFileSummary }
  | { kind: "folder"; path: string; name: string; children: FileTreeNode[]; files: DiffFileSummary[] };

function FileTreeNode({
  node,
  depth,
  expandedDirs,
  viewedFiles,
  changedSinceViewedFiles,
  commentCounts,
  activeFile,
  visibleFiles,
  onSelect,
  onToggleViewed,
  onToggleFolderViewed,
  onToggleDir,
}: {
  node: FileTreeNode;
  depth: number;
  expandedDirs: Set<string>;
  viewedFiles: Set<string>;
  changedSinceViewedFiles: Set<string>;
  commentCounts: Map<string, number>;
  activeFile: string;
  visibleFiles: Set<string>;
  onSelect(path: string): void;
  onToggleViewed(path: string): void;
  onToggleFolderViewed(path: string, viewed: boolean): void;
  onToggleDir(path: string): void;
}): React.JSX.Element {
  const indent = { "--tree-depth": depth } as React.CSSProperties;

  if (node.kind === "folder") {
    const expanded = expandedDirs.has(node.path);
    const folderFiles = node.files.filter((file) => visibleFiles.has(file.path));
    const viewed = folderFiles.length > 0 && folderFiles.every((file) => viewedFiles.has(file.path));
    const changed = folderFiles.some((file) => changedSinceViewedFiles.has(file.path));
    const comments = folderFiles.reduce((sum, file) => sum + (commentCounts.get(file.path) ?? 0), 0);
    const additions = folderFiles.reduce((sum, file) => sum + file.additions, 0);
    const deletions = folderFiles.reduce((sum, file) => sum + file.deletions, 0);
    return (
      <div className="treeGroup">
        <div className="folderRow" style={indent}>
          <button title={expanded ? "Collapse folder" : "Expand folder"} onClick={() => onToggleDir(node.path)}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
            <span>{node.name}</span>
            {changed && <span className="fileBadge updated">updated</span>}
            {comments > 0 && <span className="fileBadge comments">{comments}</span>}
          </button>
          <span className="counts">
            <span className="countAddition">+{additions}</span>
            <span className="countDeletion">-{deletions}</span>
          </span>
          <button title={viewed ? "Mark folder unviewed" : "Mark folder viewed"} onClick={() => onToggleFolderViewed(node.path, !viewed)}>
            {viewed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {expanded && node.children.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            expandedDirs={expandedDirs}
            viewedFiles={viewedFiles}
            changedSinceViewedFiles={changedSinceViewedFiles}
            commentCounts={commentCounts}
            activeFile={activeFile}
            visibleFiles={visibleFiles}
            onSelect={onSelect}
            onToggleViewed={onToggleViewed}
            onToggleFolderViewed={onToggleFolderViewed}
            onToggleDir={onToggleDir}
          />
        ))}
      </div>
    );
  }

  const viewed = viewedFiles.has(node.file.path);
  const changed = changedSinceViewedFiles.has(node.file.path);
  const comments = commentCounts.get(node.file.path) ?? 0;
  return (
    <div className={node.file.path === activeFile ? "fileRow active" : "fileRow"} style={indent}>
      <button title="Open file" onClick={() => onSelect(node.file.path)}>
        <span className={`status ${node.file.status}`}>{node.file.status[0]}</span>
        <span className={viewed ? "filePath read" : "filePath"}>{node.name}</span>
        {node.file.isGenerated && <span className="fileBadge">gen</span>}
        {changed && <span className="fileBadge updated">updated</span>}
        {comments > 0 && <span className="fileBadge comments">{comments}</span>}
      </button>
      <span className="counts">
        <span className="countAddition">+{node.file.additions}</span>
        <span className="countDeletion">-{node.file.deletions}</span>
      </span>
      <button title={viewed ? "Mark unviewed" : "Mark viewed"} onClick={() => onToggleViewed(node.file.path)}>
        {viewed ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

function buildFileTree(files: DiffFileSummary[]): { nodes: FileTreeNode[]; files: DiffFileSummary[] } {
  const root: MutableFolder = { kind: "folder", path: "", name: "", children: new Map(), files: [] };

  for (const file of files) {
    let current = root;
    current.files.push(file);
    const parts = file.path.split("/");
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index] ?? "";
      const path = parts.slice(0, index + 1).join("/");
      if (index === parts.length - 1) {
        current.children.set(path, { kind: "file", path, name, file });
        continue;
      }
      const existing = current.children.get(path);
      const folder: MutableFolder = existing?.kind === "folder" ? existing : { kind: "folder", path, name, children: new Map(), files: [] };
      folder.files.push(file);
      current.children.set(path, folder);
      current = folder;
    }
  }

  return { nodes: sortTreeNodes([...root.children.values()]).map(compactSingleFolder), files };
}

function matchesSidebarFilters(
  file: DiffFileSummary,
  search: string,
  filters: Set<SidebarFilter>,
  viewedFiles: Set<string>,
  changedSinceViewedFiles: Set<string>,
  commentCounts: Map<string, number>,
): boolean {
  const loweredSearch = search.trim().toLowerCase();
  if (loweredSearch && !file.path.toLowerCase().includes(loweredSearch)) return false;
  if (filters.has("open") && viewedFiles.has(file.path)) return false;
  if (filters.has("viewed") && !viewedFiles.has(file.path)) return false;
  if (filters.has("updated") && !changedSinceViewedFiles.has(file.path)) return false;
  if (filters.has("comments") && !(commentCounts.get(file.path) ?? 0)) return false;
  if (filters.has("generated") && !file.isGenerated) return false;
  return true;
}

type MutableFolder = { kind: "folder"; path: string; name: string; children: Map<string, MutableTreeNode>; files: DiffFileSummary[] };
type MutableTreeNode = MutableFolder | { kind: "file"; path: string; name: string; file: DiffFileSummary };

function sortTreeNodes(nodes: MutableTreeNode[]): FileTreeNode[] {
  return nodes
    .map((node): FileTreeNode => {
      if (node.kind === "file") return node;
      return { ...node, children: sortTreeNodes([...node.children.values()]) };
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function compactSingleFolder(node: FileTreeNode): FileTreeNode {
  if (node.kind === "file") return node;
  const children = node.children.map(compactSingleFolder);
  if (children.length === 1 && children[0]?.kind === "folder") {
    return {
      ...children[0],
      name: `${node.name}/${children[0].name}`,
    };
  }
  return { ...node, children };
}

function collectFolderPaths(tree: { nodes: FileTreeNode[] }): string[] {
  const paths: string[] = [];
  const visit = (node: FileTreeNode): void => {
    if (node.kind !== "folder") return;
    paths.push(node.path);
    node.children.forEach(visit);
  };
  tree.nodes.forEach(visit);
  return paths;
}
