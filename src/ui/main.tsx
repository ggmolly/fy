import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CodeView as PierreCodeView } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewItem, type DiffLineAnnotation } from "@pierre/diffs/react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderGit,
  GitBranch,
  Maximize2,
  MessageSquareReply,
  MessageSquarePlus,
  RefreshCw,
  Rows3,
  Send,
  Trash2,
} from "lucide-react";
import type {
  ComparisonReviewState,
  DiffResponse,
  GitRef,
  ReviewFinding,
  SessionMetadata,
  ViewedFileHashRecord,
} from "../shared/types";
import { FloatingPanel, StateBanner } from "./components/Chrome";
import { HeaderCollapseToggle, HeaderMetadata } from "./components/DiffHeader";
import { FilePreview } from "./components/FilePreview";
import { InlineFileFindingForm, InlineFindingForm } from "./components/InlineFindingForms";
import { ReviewAnnotation } from "./components/ReviewAnnotation";
import { AutoViewRulesEditor, FileList, ReviewProgress } from "./components/Sidebar";
import { api, parseWatchEvent } from "./lib/api";
import { matchesAutoViewRules, parseAutoViewRules } from "./lib/autoViewRules";
import { getContext, getSelectedCode } from "./lib/selection";
import { isPreviewableFile, resolvePreviewRefs } from "./lib/preview";
import { formatFindingForMarkdown, isQuestionFinding, lineLabel, renderCodexPrompt } from "./lib/reviewFormat";
import { hashItemVersion, viewedHashKey } from "./lib/reviewKeys";
import { mergeRemoteReview, sameReview } from "./reviewSync";
import type { CodeViewLineSelection, LoadState, PromptMode, ReviewLineAnnotation } from "./types";
import "./styles.css";

const defaultSidebarWidth = 320;
const minSidebarWidth = 260;
const maxSidebarWidth = 560;
function App(): React.JSX.Element {
  const viewerRef = useRef<CodeViewHandle<ReviewLineAnnotation>>(null);
  const editingFindingIdsRef = useRef<Set<string>>(new Set());
  const skipNextReviewSaveRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  const [session, setSession] = useState<SessionMetadata | null>(null);
  const [refs, setRefs] = useState<GitRef[]>([]);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [review, setReview] = useState<ComparisonReviewState | null>(null);
  const [viewedHashIndex, setViewedHashIndex] = useState<ViewedFileHashRecord[]>([]);
  const [autoViewRules, setAutoViewRules] = useState<string[]>([]);
  const [autoViewRulesDraft, setAutoViewRulesDraft] = useState("");
  const [baseRef, setBaseRef] = useState("origin/main");
  const [headRef, setHeadRef] = useState("HEAD");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [selectedLines, setSelectedLines] = useState<CodeViewLineSelection | null>(null);
  const [draftSelection, setDraftSelection] = useState<CodeViewLineSelection | null>(null);
  const [fileDraftPath, setFileDraftPath] = useState<string | null>(null);
  const [focusedFile, setFocusedFile] = useState("");
  const [draft, setDraft] = useState({ comment: "", fileComment: "" });
  const [message, setMessage] = useState("");
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [promptMode, setPromptMode] = useState<PromptMode>("all");
  const [activeDiffParams, setActiveDiffParams] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth);
  const workspaceStyle = { "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties;

  const beginSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (sidebarCollapsed) return;
    event.preventDefault();

    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    handle.setPointerCapture(pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const resize = (moveEvent: PointerEvent): void => {
      setSidebarWidth(Math.min(maxSidebarWidth, Math.max(minSidebarWidth, startWidth + moveEvent.clientX - startX)));
    };
    const stop = (): void => {
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };

    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }, [sidebarCollapsed, sidebarWidth]);


  const loadRepo = useCallback(async () => {
    const [sessionResponse, refsResponse] = await Promise.all([
      api<SessionMetadata>("/api/session"),
      api<{ refs: GitRef[] }>("/api/git/refs"),
    ]);
    setSession(sessionResponse);
    setRefs(refsResponse.refs);
    setBaseRef(sessionResponse.initialBaseRef);
    setHeadRef(sessionResponse.initialHeadRef);
    setIncludeUntracked(sessionResponse.includeUntracked);
    await loadDiff(new URLSearchParams(), sessionResponse.comparisonKey);
  }, []);

  useEffect(() => {
    loadRepo().catch((error) => setMessage(error.message));
  }, [loadRepo]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 3500);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!review) return;
    if (skipNextReviewSaveRef.current) {
      skipNextReviewSaveRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      api<ComparisonReviewState>("/api/review", { method: "POST", body: JSON.stringify(review) }).catch((error) => setMessage(error.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [review]);

  useEffect(() => {
    if (!diff) return;
    const source = new EventSource(`/api/watch${activeDiffParams ? `?${activeDiffParams}` : ""}`);
    const markDiffStale = (): void => setNeedsReload(true);
    const syncReview = (event: Event): void => {
      const payload = parseWatchEvent(event);
      if (!payload?.comparisonKey || payload.comparisonKey !== diff.comparisonKey) return;
      void loadRemoteReview(payload.comparisonKey);
    };
    source.addEventListener("diff-changed", markDiffStale);
    source.addEventListener("review-changed", syncReview);
    source.addEventListener("error", () => source.close());
    return () => source.close();
  }, [activeDiffParams, diff]);

  const viewedFileRecords = useMemo(() => new Map(review?.viewedFiles.map((file) => [file.path, file]) ?? []), [review]);
  const viewedHashRecords = useMemo(() => {
    const records = new Map<string, ViewedFileHashRecord>();
    for (const record of viewedHashIndex) records.set(viewedHashKey(record.path, record.contentHash), record);
    for (const record of review?.viewedFiles ?? []) records.set(viewedHashKey(record.path, record.contentHash), record);
    return records;
  }, [review, viewedHashIndex]);
  const viewedFilePaths = useMemo(() => {
    const viewed = new Set<string>();
    if (!diff) return viewed;
    for (const file of diff.files) {
      const record = viewedFileRecords.get(file.path);
      if (record?.contentHash === file.contentHash || viewedHashRecords.has(viewedHashKey(file.path, file.contentHash))) {
        viewed.add(file.path);
      }
    }
    return viewed;
  }, [diff, viewedFileRecords, viewedHashRecords]);
  const changedSinceViewedFiles = useMemo(() => {
    const changed = new Set<string>();
    if (!diff) return changed;
    for (const file of diff.files) {
      const record = viewedFileRecords.get(file.path);
      const priorPathView = viewedHashIndex.some((viewed) => viewed.path === file.path && viewed.contentHash !== file.contentHash);
      if (!viewedFilePaths.has(file.path) && ((record && record.contentHash !== file.contentHash) || priorPathView)) {
        changed.add(file.path);
      }
    }
    return changed;
  }, [diff, viewedFilePaths, viewedFileRecords, viewedHashIndex]);

  const fileByPath = useMemo(() => new Map(diff?.files.map((file) => [file.path, file]) ?? []), [diff]);
  const commentCountsByFile = useMemo(() => {
    const counts = new Map<string, number>();
    for (const finding of review?.findings ?? []) {
      if (finding.status !== "open") continue;
      counts.set(finding.filePath, (counts.get(finding.filePath) ?? 0) + 1);
    }
    return counts;
  }, [review]);
  const outdatedFindingIds = useMemo(() => {
    const ids = new Set<string>();
    if (!review) return ids;
    for (const finding of review.findings) {
      const currentHash = fileByPath.get(finding.filePath)?.contentHash;
      if (finding.fileContentHash && currentHash && finding.fileContentHash !== currentHash) {
        ids.add(finding.id);
      }
    }
    return ids;
  }, [fileByPath, review]);
  const reviewProgress = useMemo(() => ({
    files: diff?.files.length ?? 0,
    viewed: diff?.files.filter((file) => viewedFilePaths.has(file.path)).length ?? 0,
    openComments: review?.findings.filter((finding) => finding.status === "open").length ?? 0,
    outdatedComments: review?.findings.filter((finding) => outdatedFindingIds.has(finding.id)).length ?? 0,
    updatedFiles: changedSinceViewedFiles.size,
  }), [changedSinceViewedFiles, diff, outdatedFindingIds, review, viewedFilePaths]);
  const hasOpenQuestion = useMemo(
    () => review?.findings.some((finding) => finding.status === "open" && isQuestionFinding(finding)) ?? false,
    [review],
  );

  useEffect(() => {
    if (!hasOpenQuestion && promptMode !== "all") setPromptMode("all");
  }, [hasOpenQuestion, promptMode]);

  const effectiveCollapsedFiles = useMemo(() => {
    const collapsed = new Set<string>();
    if (!diff || !review) return collapsed;
    const manualCollapsed = new Set(review.collapsedFiles);
    const manualExpanded = new Set(review.expandedFiles);
    for (const file of diff.files) {
      if (manualExpanded.has(file.path)) continue;
      if (manualCollapsed.has(file.path) || viewedFilePaths.has(file.path)) {
        collapsed.add(file.path);
      }
    }
    return collapsed;
  }, [diff, review, viewedFilePaths]);

  useEffect(() => {
    if (!diff || !review) return;
    const now = new Date().toISOString();
    const currentViewed = new Map(review.viewedFiles.map((file) => [file.path, file]));
    const nextViewed = new Map(currentViewed);
    let changed = false;
    for (const file of diff.files) {
      if (!file.isGenerated && file.status !== "deleted" && !matchesAutoViewRules(file.path, autoViewRules)) continue;
      if (currentViewed.get(file.path)?.contentHash === file.contentHash) continue;
      nextViewed.set(file.path, { path: file.path, contentHash: file.contentHash, viewedAt: now });
      changed = true;
    }
    if (changed) {
      const records = [...nextViewed.values()];
      setReview({ ...review, viewedFiles: records, updatedAt: now });
      void saveViewedHashRecords(records);
    }
  }, [autoViewRules, diff, review]);

  const items = useMemo<CodeViewItem<ReviewLineAnnotation>[]>(() => {
    if (!diff || !review) return [];
    const previewRefs = resolvePreviewRefs(diff.comparisonKey);
    return diff.parsedFiles.map((fileDiff) => {
      const file = diff.files.find((candidate) => candidate.path === fileDiff.name);
      const openFindings = review.findings.filter((finding) => finding.filePath === fileDiff.name && finding.status === "open");
      const collapsed = effectiveCollapsedFiles.has(fileDiff.name);
      const hasDraft = draftSelection?.id === fileDiff.name;
      const hasFileDraft = fileDraftPath === fileDiff.name;
      return {
        id: fileDiff.name,
        type: "diff",
        fileDiff,
        collapsed,
        version: hashItemVersion(fileDiff.name, collapsed, hasDraft || hasFileDraft, openFindings),
        annotations: [
          ...(file && hasFileDraft
            ? [
                {
                  side: file.status === "deleted" ? "deletions" : "additions",
                  lineNumber: 0,
                  metadata: { kind: "fileDraft" as const, file },
                } satisfies DiffLineAnnotation<ReviewLineAnnotation>,
              ]
            : []),
          ...(file && isPreviewableFile(file.path) && !collapsed
            ? [
                {
                  side: file.status === "deleted" ? "deletions" : "additions",
                  lineNumber: 0,
                  metadata: { kind: "preview" as const, file, refs: previewRefs },
                } satisfies DiffLineAnnotation<ReviewLineAnnotation>,
              ]
            : []),
          ...openFindings.map((finding): DiffLineAnnotation<ReviewLineAnnotation> => ({
            side: finding.newLine != null ? "additions" : "deletions",
            lineNumber: finding.newLine ?? finding.oldLine ?? 0,
            metadata: { kind: "finding" as const, finding },
          })),
          ...(hasDraft && draftSelection
            ? [
                {
                  side: draftSelection.range.endSide ?? draftSelection.range.side ?? "additions",
                  lineNumber: draftSelection.range.end,
                  metadata: { kind: "draft" as const, selection: draftSelection },
                } satisfies DiffLineAnnotation<ReviewLineAnnotation>,
              ]
            : []),
        ],
      };
    });
  }, [diff, draftSelection, effectiveCollapsedFiles, fileDraftPath, review]);

  const activeFile = focusedFile || draftSelection?.id || selectedLines?.id || diff?.files[0]?.path || "";
  const refOptions = useMemo(() => {
    const values = new Set(refs.map((ref) => ref.name));
    const options = [...refs];
    if (baseRef && !values.has(baseRef)) options.unshift({ name: baseRef, kind: "local" });
    if (headRef && !values.has(headRef)) options.unshift({ name: headRef, kind: "head" });
    return options;
  }, [baseRef, headRef, refs]);

  async function loadDiff(params: URLSearchParams, expectedKey?: string): Promise<void> {
    const requestId = ++loadRequestIdRef.current;
    setLoadState({ status: "loading", message: "Loading diff..." });
    try {
      const query = params.toString();
      const nextDiff = await api<DiffResponse>(`/api/diff${query ? `?${query}` : ""}`);
      if (requestId !== loadRequestIdRef.current) return;

      const [nextReview, nextIndex, nextRules] = await Promise.all([
        api<ComparisonReviewState>(`/api/review?comparisonKey=${encodeURIComponent(expectedKey ?? nextDiff.comparisonKey)}`),
        api<{ viewedFileHashes: ViewedFileHashRecord[] }>("/api/review/viewed-index"),
        api<{ autoViewRules: string[] }>("/api/review/auto-view-rules"),
      ]);
      if (requestId !== loadRequestIdRef.current) return;

      setDiff(nextDiff);
      setReview(nextReview);
      setViewedHashIndex(nextIndex.viewedFileHashes);
      setAutoViewRules(nextRules.autoViewRules);
      setAutoViewRulesDraft(nextRules.autoViewRules.join("\n"));
      setSelectedLines(null);
      setDraftSelection(null);
      setFileDraftPath(null);
      setFocusedFile(nextDiff.files[0]?.path ?? "");
      setActiveDiffParams(query);
      setNeedsReload(false);
      setLoadState(nextDiff.raw.trim() === "" ? { status: "empty", message: "No diff for this selection." } : { status: "ready" });
    } catch (error) {
      if (requestId !== loadRequestIdRef.current) return;
      setLoadState({ status: "error", message: error instanceof Error ? error.message : "Failed to load diff." });
    }
  }

  async function refreshCurrentDiff(): Promise<void> {
    const [sessionResponse, refsResponse] = await Promise.all([
      api<SessionMetadata>("/api/session"),
      api<{ refs: GitRef[] }>("/api/git/refs"),
    ]);
    setSession(sessionResponse);
    setRefs(refsResponse.refs);
    await loadDiff(new URLSearchParams(activeDiffParams), diff?.comparisonKey);
  }

  async function loadRemoteReview(comparisonKey: string): Promise<void> {
    try {
      const remoteReview = await api<ComparisonReviewState>(`/api/review?comparisonKey=${encodeURIComponent(comparisonKey)}`);
      setReview((current) => {
        if (!current || current.comparisonKey !== remoteReview.comparisonKey) return current;
        const merged = mergeRemoteReview(current, remoteReview, editingFindingIdsRef.current);
        if (sameReview(current, merged)) return current;
        skipNextReviewSaveRef.current = true;
        return merged;
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to sync review.");
    }
  }

  async function applyComparison(nextBase = baseRef, nextHead = headRef): Promise<void> {
    const params = new URLSearchParams();
    params.set("base", nextBase);
    params.set("head", nextHead);
    await loadDiff(params);
  }

  async function showUnstagedChanges(nextIncludeUntracked = includeUntracked): Promise<void> {
    const params = new URLSearchParams();
    params.set("working", "true");
    if (!nextIncludeUntracked) params.set("untracked", "false");
    await loadDiff(params);
  }
  function toggleUntracked(): void {
    const nextIncludeUntracked = !includeUntracked;
    setIncludeUntracked(nextIncludeUntracked);
    if (diff?.comparisonKey === "working" || diff?.comparisonKey === "working-no-untracked") {
      void showUnstagedChanges(nextIncludeUntracked);
    }
  }

  function selectBaseRef(nextBase: string): void {
    setBaseRef(nextBase);
    void applyComparison(nextBase, headRef);
  }

  function selectHeadRef(nextHead: string): void {
    setHeadRef(nextHead);
    void applyComparison(baseRef, nextHead);
  }

  const setFindingEditing = useCallback((id: string, editing: boolean): void => {
    if (editing) editingFindingIdsRef.current.add(id);
    else editingFindingIdsRef.current.delete(id);
  }, []);

  function syncFocusedFileFromScroll(scrollTop: number, viewer: PierreCodeView<ReviewLineAnnotation>): void {
    if (!diff?.files.length) return;
    const anchorTop = scrollTop + 32;
    let nextFile = diff.files[0]?.path ?? "";
    for (const file of diff.files) {
      const top = viewer.getTopForItem(file.path);
      if (top == null) continue;
      if (top > anchorTop) break;
      nextFile = file.path;
    }
    if (nextFile) {
      setFocusedFile((current) => (current === nextFile ? current : nextFile));
    }
  }

  function updateReview(update: (current: ComparisonReviewState) => ComparisonReviewState): void {
    setReview((current) => (current ? update(current) : current));
  }

  function addFinding(): void {
    if (!review || !draftSelection || !draft.comment.trim()) return;
    const now = new Date().toISOString();
    const file = draftSelection.id;
    const side = draftSelection.range.endSide ?? draftSelection.range.side;
    const finding: ReviewFinding = {
      id: crypto.randomUUID(),
      comparisonKey: review.comparisonKey,
      filePath: file,
      fileContentHash: diff?.files.find((candidate) => candidate.path === file)?.contentHash,
      oldLine: side === "deletions" ? draftSelection.range.end : undefined,
      newLine: side !== "deletions" ? draftSelection.range.end : undefined,
      range: draftSelection.range,
      author: "molly",
      comment: draft.comment.trim(),
      status: "open",
      replies: [],
      context: getContext(diff?.parsedFiles.find((candidate) => candidate.name === file), draftSelection),
      selectedCode: getSelectedCode(diff?.parsedFiles.find((candidate) => candidate.name === file), draftSelection),
      createdAt: now,
      updatedAt: now,
    };
    updateReview((current) => ({ ...current, findings: [...current.findings, finding], updatedAt: now }));
    setDraft((current) => ({ ...current, comment: "" }));
    setDraftSelection(null);
    setSelectedLines(null);
  }

  function addFileFinding(): void {
    if (!review || !fileDraftPath || !draft.fileComment.trim()) return;
    const now = new Date().toISOString();
    const finding: ReviewFinding = {
      id: crypto.randomUUID(),
      comparisonKey: review.comparisonKey,
      filePath: fileDraftPath,
      fileContentHash: diff?.files.find((candidate) => candidate.path === fileDraftPath)?.contentHash,
      author: "molly",
      comment: draft.fileComment.trim(),
      status: "open",
      replies: [],
      createdAt: now,
      updatedAt: now,
    };
    updateReview((current) => ({ ...current, findings: [...current.findings, finding], updatedAt: now }));
    setDraft((current) => ({ ...current, fileComment: "" }));
    setFileDraftPath(null);
  }

  async function copyPrompt(): Promise<void> {
    if (!review) return;
    const prompt = renderCodexPrompt(review, promptMode);
    await navigator.clipboard.writeText(prompt);
    setMessage(`Copied ${promptMode === "all" ? "Codex" : promptMode} prompt.`);
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <strong>fy</strong>
          {session?.githubRemote && (
            <span className="metaPill">
              <FolderGit size={14} />
              {session.githubRemote.owner}/{session.githubRemote.repo}
            </span>
          )}
          <span className="metaPill">
            <GitBranch size={14} />
            {session?.currentBranch ?? "detached"}
          </span>
        </div>
        <div className="controls">
          <label className="selectLabel">
            <span>Base:</span>
            <select value={baseRef} onChange={(event) => selectBaseRef(event.target.value)}>
              {refOptions.map((ref) => <option key={`${ref.kind}:${ref.name}`} value={ref.name}>{ref.name}</option>)}
            </select>
          </label>
          <span className="swapIcon">↔</span>
          <label className="selectLabel">
            <span>Head:</span>
            <select value={headRef} onChange={(event) => selectHeadRef(event.target.value)}>
              {refOptions.map((ref) => <option key={`${ref.kind}:${ref.name}`} value={ref.name}>{ref.name}</option>)}
            </select>
          </label>
          <button className={diff?.comparisonKey === "working" || diff?.comparisonKey === "working-no-untracked" ? "active" : ""} title="Show unstaged working tree changes" onClick={() => void showUnstagedChanges()}>Unstaged</button>
          <button className={includeUntracked ? "active" : ""} aria-pressed={includeUntracked} title="Include untracked files in working tree comparisons" onClick={toggleUntracked}>Untracked</button>
          <button onClick={() => void applyComparison()}>Compare</button>
          <button className={needsReload ? "active" : ""} title="Refresh" onClick={() => void refreshCurrentDiff()}><RefreshCw size={15} /> {needsReload ? "Updated" : "Refresh"}</button>
          <div className="toolbarDivider" />
          <button className={review?.layout === "split" ? "active" : ""} title="Split view" onClick={() => setLayout("split")}><Maximize2 size={15} /> Split</button>
          <button className={review?.layout === "unified" ? "active" : ""} title="Unified view" onClick={() => setLayout("unified")}><Rows3 size={15} /> Unified</button>
          <button className={findingsOpen ? "active" : ""} title="Findings" onClick={() => setFindingsOpen((open) => !open)}>
            <MessageSquarePlus size={15} /> {review?.findings.filter((finding) => finding.status === "open").length ?? 0}
          </button>
          <button title="Copy review markdown" onClick={() => void copyMarkdown()}><Copy size={15} /></button>
          {hasOpenQuestion && (
            <select className="promptModeSelect" value={promptMode} onChange={(event) => setPromptMode(event.target.value as PromptMode)} title="Prompt mode">
              <option value="all">All</option>
              <option value="fixes">Fixes only</option>
              <option value="questions">Questions only</option>
            </select>
          )}
          <button className="primary" title="Copy prompt for Codex" onClick={() => void copyPrompt()}><Send size={15} /></button>
        </div>
      </header>

      <section className={sidebarCollapsed ? "workspace sidebarCollapsed" : "workspace"} style={workspaceStyle}>
        <aside className={sidebarCollapsed ? "sidebar collapsed" : "sidebar"} aria-label="Changed files">
          {sidebarCollapsed ? (
            <div className="sidebarCollapsedContent">
              <button title="Expand sidebar" onClick={() => setSidebarCollapsed(false)} aria-label="Expand changed files sidebar">
                <ChevronRight size={16} />
              </button>
              <span className="sidebarCollapsedCount">{diff?.files.length ?? 0}</span>
              <span className="sidebarCollapsedLabel">Files</span>
            </div>
          ) : (
            <>
              <div className="panelHeader sidebarHeader">
                <h2>Changed files</h2>
                <div className="sidebarHeaderActions">
                  <span>{diff?.files.length ?? 0}</span>
                  <button title="Collapse sidebar" onClick={() => setSidebarCollapsed(true)} aria-label="Collapse changed files sidebar">
                    <ChevronLeft size={15} />
                  </button>
                </div>
              </div>
              <ReviewProgress progress={reviewProgress} />
              <FileList
                files={diff?.files ?? []}
                viewedFiles={viewedFilePaths}
                changedSinceViewedFiles={changedSinceViewedFiles}
                commentCounts={commentCountsByFile}
                activeFile={activeFile}
                onSelect={(path) => {
                  setFocusedFile(path);
                  setSelectedLines(null);
                  setDraftSelection(null);
                  setFileDraftPath(null);
                  viewerRef.current?.scrollTo({ type: "item", id: path, behavior: "smooth-auto" });
                }}
                onToggleViewed={toggleFileViewed}
                onToggleFolderViewed={toggleFolderViewed}
              />
              <AutoViewRulesEditor
                value={autoViewRulesDraft}
                onChange={setAutoViewRulesDraft}
                onSave={() => void saveAutoViewRules(autoViewRulesDraft)}
              />
            </>
          )}
        </aside>
        {!sidebarCollapsed && (
          <div
            className="sidebarResizeHandle"
            role="separator"
            aria-label="Resize changed files sidebar"
            aria-orientation="vertical"
            tabIndex={0}
            onDoubleClick={() => setSidebarWidth(defaultSidebarWidth)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setSidebarWidth((current) => Math.min(maxSidebarWidth, Math.max(minSidebarWidth, current - 24)));
              if (event.key === "ArrowRight") setSidebarWidth((current) => Math.min(maxSidebarWidth, Math.max(minSidebarWidth, current + 24)));
              if (event.key === "Enter") setSidebarWidth(defaultSidebarWidth);
            }}
            onPointerDown={beginSidebarResize}
          />
        )}

        <section className="diffPane">
          {message && <div className="message">{message}</div>}
          {loadState.status !== "ready" && (
            <StateBanner
              state={loadState}
              onRetry={() => void refreshCurrentDiff()}
            />
          )}
          <CodeView
            ref={viewerRef}
            className="codeViewRoot"
            items={items}
            selectedLines={selectedLines}
            onScroll={syncFocusedFileFromScroll}
            onSelectedLinesChange={(selection) => {
              setSelectedLines(selection);
              if (selection) setFocusedFile(selection.id);
            }}
            renderHeaderPrefix={(item) => (
              <HeaderCollapseToggle
                collapsed={effectiveCollapsedFiles.has(item.id)}
                onToggle={() => toggleFileCollapse(item.id)}
              />
            )}
            renderHeaderMetadata={(item) => (
              <HeaderMetadata
                file={diff?.files.find((candidate) => candidate.path === item.id)}
                viewed={viewedFilePaths.has(item.id)}
                changedSinceViewed={changedSinceViewedFiles.has(item.id)}
                onToggleViewed={() => toggleFileViewed(item.id)}
                onOpenInEditor={() => void openInEditor(item.id)}
                onAddFileComment={() => {
                  setSelectedLines(null);
                  setDraftSelection(null);
                  setFileDraftPath((current) => (current === item.id ? null : item.id));
                }}
              />
            )}
            options={{
              diffStyle: review?.layout ?? "split",
              themeType: "light",
              stickyHeaders: true,
              enableLineSelection: true,
              overflow: "scroll",
              hunkSeparators: "line-info-basic",
              onLineSelectionStart: () => setDraftSelection(null),
              onLineSelectionEnd: (range, context) => {
                const selection = range == null ? null : { id: context.item.id, range };
                setSelectedLines(selection);
                setDraftSelection(selection);
              },
            }}
            renderAnnotation={(annotation) => {
              if (!annotation.metadata) return null;
              if (annotation.metadata.kind === "preview") {
                return <FilePreview file={annotation.metadata.file} refs={annotation.metadata.refs} />;
              }
              if (annotation.metadata.kind === "fileDraft") {
                return (
                  <InlineFileFindingForm
                    file={annotation.metadata.file}
                    value={draft.fileComment}
                    onChange={(fileComment) => setDraft((current) => ({ ...current, fileComment }))}
                    onClose={() => setFileDraftPath(null)}
                    onSubmit={addFileFinding}
                  />
                );
              }
              if (annotation.metadata.kind === "draft") {
                const selection = annotation.metadata.selection;
                return (
                  <InlineFindingForm
                    draft={draft}
                    selectedLines={selection}
                    selectedCode={getSelectedCode(
                      diff?.parsedFiles.find((candidate) => candidate.name === selection.id),
                      selection,
                    )}
                    onChange={(next) => setDraft((current) => ({ ...current, comment: next.comment }))}
                    onClose={() => {
                      setDraftSelection(null);
                      setSelectedLines(null);
                    }}
                    onSubmit={addFinding}
                  />
                );
              }
              return (
                <ReviewAnnotation
                  finding={annotation.metadata.finding}
                  outdated={outdatedFindingIds.has(annotation.metadata.finding.id)}
                  onDelete={deleteFinding}
                  onToggle={toggleFinding}
                  onUpdateComment={updateFindingComment}
                  onReply={replyToFinding}
                  onDeleteReply={deleteFindingReply}
                  onEditingChange={setFindingEditing}
                />
              );
            }}
          />

          {findingsOpen && review && (
            <FloatingPanel title="Findings" onClose={() => setFindingsOpen(false)}>
              <div className="findings compact">
                {review.findings.length === 0 && <p className="emptyText">No findings yet. Select lines in the diff to add one.</p>}
                {review.findings.map((finding) => (
                  <article
                    key={finding.id}
                    className={finding.status === "resolved" ? "resolved" : ""}
                    role="button"
                    tabIndex={0}
                    onClick={() => jumpToFinding(finding)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") jumpToFinding(finding);
                    }}
                  >
                    <strong>{finding.status === "open" ? "Open" : "Resolved"} {outdatedFindingIds.has(finding.id) ? "- Outdated" : ""}</strong>
                    <span>{finding.filePath}{lineLabel(finding)}</span>
                    <span>{finding.author}</span>
                    <p>{finding.comment}</p>
                    {finding.replies.length > 0 && (
                      <div className="replyList">
                        {finding.replies.map((reply) => (
                          <p key={reply.id}><strong>{reply.author}</strong>: {reply.body}</p>
                        ))}
                      </div>
                    )}
                    <div className="findingActions" onClick={(event) => event.stopPropagation()}>
                      <button onClick={() => toggleFinding(finding.id)}>{finding.status === "open" ? "Resolve" : "Reopen"}</button>
                      <button onClick={() => void replyFromPrompt(finding.id)}><MessageSquareReply size={14} /> Reply</button>
                      <button title="Delete comment" onClick={() => deleteFinding(finding.id)}><Trash2 size={14} /></button>
                    </div>
                  </article>
                ))}
              </div>
            </FloatingPanel>
          )}
        </section>
      </section>
    </main>
  );

  function toggleFileViewed(path: string): void {
    updateReview((current) => {
      const file = diff?.files.find((candidate) => candidate.path === path);
      if (!file) return current;
      const viewedFiles = new Map(current.viewedFiles.map((record) => [record.path, record]));
      const expandedFiles = new Set(current.expandedFiles);
      const removedViewedHashes: Array<Pick<ViewedFileHashRecord, "path" | "contentHash">> = [];
      if (viewedFiles.get(path)?.contentHash === file.contentHash) {
        viewedFiles.delete(path);
        removedViewedHashes.push({ path, contentHash: file.contentHash });
      } else {
        viewedFiles.set(path, { path, contentHash: file.contentHash, viewedAt: new Date().toISOString() });
        expandedFiles.delete(path);
      }
      void saveViewedHashRecords([...viewedFiles.values()], removedViewedHashes);
      return {
        ...current,
        viewedFiles: [...viewedFiles.values()],
        expandedFiles: [...expandedFiles],
        updatedAt: new Date().toISOString(),
      };
    });
  }

  function toggleFolderViewed(folderPath: string, viewed: boolean): void {
    updateReview((current) => {
      if (!diff) return current;
      const now = new Date().toISOString();
      const viewedFiles = new Map(current.viewedFiles.map((record) => [record.path, record]));
      const expandedFiles = new Set(current.expandedFiles);
      const removedViewedHashes: Array<Pick<ViewedFileHashRecord, "path" | "contentHash">> = [];
      const prefix = `${folderPath}/`;
      for (const file of diff.files) {
        if (file.path !== folderPath && !file.path.startsWith(prefix)) continue;
        if (viewed) {
          viewedFiles.set(file.path, { path: file.path, contentHash: file.contentHash, viewedAt: now });
          expandedFiles.delete(file.path);
        } else {
          viewedFiles.delete(file.path);
          removedViewedHashes.push({ path: file.path, contentHash: file.contentHash });
          expandedFiles.add(file.path);
        }
      }
      const records = [...viewedFiles.values()];
      void saveViewedHashRecords(records, removedViewedHashes);
      return {
        ...current,
        viewedFiles: records,
        expandedFiles: [...expandedFiles],
        updatedAt: now,
      };
    });
  }

  async function saveViewedHashRecords(
    records: ViewedFileHashRecord[],
    removedRecords: Array<Pick<ViewedFileHashRecord, "path" | "contentHash">> = [],
  ): Promise<void> {
    const byKey = new Map(viewedHashIndex.map((record) => [viewedHashKey(record.path, record.contentHash), record]));
    for (const record of removedRecords) byKey.delete(viewedHashKey(record.path, record.contentHash));
    for (const record of records) byKey.set(viewedHashKey(record.path, record.contentHash), record);
    const next = [...byKey.values()];
    setViewedHashIndex(next);
    await api<{ viewedFileHashes: ViewedFileHashRecord[] }>("/api/review/viewed-index", {
      method: "POST",
      body: JSON.stringify({ viewedFileHashes: next }),
    }).then((response) => setViewedHashIndex(response.viewedFileHashes));
  }

  async function openInEditor(path: string, line?: number): Promise<void> {
    await api<{ ok: true }>("/api/open-in-editor", {
      method: "POST",
      body: JSON.stringify({ path, line }),
    });
    setMessage("Opened in editor.");
  }

  async function saveAutoViewRules(value: string): Promise<void> {
    const rules = parseAutoViewRules(value);
    const response = await api<{ autoViewRules: string[] }>("/api/review/auto-view-rules", {
      method: "POST",
      body: JSON.stringify({ autoViewRules: rules }),
    });
    setAutoViewRules(response.autoViewRules);
    setAutoViewRulesDraft(response.autoViewRules.join("\n"));
    setMessage("Saved auto-view rules.");
  }

  function toggleFileCollapse(path: string): void {
    updateReview((current) => {
      const collapsedFiles = new Set(current.collapsedFiles);
      const expandedFiles = new Set(current.expandedFiles);
      const isCollapsed = effectiveCollapsedFiles.has(path);

      if (isCollapsed) {
        collapsedFiles.delete(path);
        expandedFiles.add(path);
      } else {
        expandedFiles.delete(path);
        collapsedFiles.add(path);
      }

      return {
        ...current,
        collapsedFiles: [...collapsedFiles],
        expandedFiles: [...expandedFiles],
        updatedAt: new Date().toISOString(),
      };
    });
  }

  function setLayout(layout: "split" | "unified"): void {
    updateReview((current) => ({ ...current, layout, updatedAt: new Date().toISOString() }));
  }

  function toggleFinding(id: string): void {
    updateReview((current) => ({
      ...current,
      findings: current.findings.map((finding) =>
        finding.id === id
          ? { ...finding, status: finding.status === "open" ? "resolved" : "open", updatedAt: new Date().toISOString() }
          : finding,
      ),
      updatedAt: new Date().toISOString(),
    }));
  }

  function deleteFinding(id: string): void {
    updateReview((current) => ({
      ...current,
      findings: current.findings.filter((finding) => finding.id !== id),
      updatedAt: new Date().toISOString(),
    }));
  }

  function updateFindingComment(id: string, comment: string): void {
    const now = new Date().toISOString();
    updateReview((current) => ({
      ...current,
      findings: current.findings.map((finding) => (finding.id === id ? { ...finding, comment, updatedAt: now } : finding)),
      updatedAt: now,
    }));
  }

  function replyToFinding(id: string, body: string): void {
    const now = new Date().toISOString();
    updateReview((current) => ({
      ...current,
      findings: current.findings.map((finding) =>
        finding.id === id
          ? {
              ...finding,
              replies: [
                ...finding.replies,
                { id: crypto.randomUUID(), author: "molly", body: body.trim(), createdAt: now, updatedAt: now },
              ],
              updatedAt: now,
            }
          : finding,
      ),
      updatedAt: now,
    }));
  }

  function deleteFindingReply(findingId: string, replyId: string): void {
    const now = new Date().toISOString();
    updateReview((current) => ({
      ...current,
      findings: current.findings.map((finding) =>
        finding.id === findingId
          ? { ...finding, replies: finding.replies.filter((reply) => reply.id !== replyId), updatedAt: now }
          : finding,
      ),
      updatedAt: now,
    }));
  }

  function replyFromPrompt(id: string): void {
    const body = window.prompt("Reply");
    if (body?.trim()) replyToFinding(id, body);
  }

  function jumpToFinding(finding: ReviewFinding): void {
    setFocusedFile(finding.filePath);
    setSelectedLines(null);
    setDraftSelection(null);
    setFileDraftPath(null);
    updateReview((current) => {
      const collapsedFiles = new Set(current.collapsedFiles);
      const expandedFiles = new Set(current.expandedFiles);
      collapsedFiles.delete(finding.filePath);
      expandedFiles.add(finding.filePath);
      return { ...current, collapsedFiles: [...collapsedFiles], expandedFiles: [...expandedFiles], updatedAt: new Date().toISOString() };
    });
    window.setTimeout(() => {
      const lineNumber = finding.newLine ?? finding.oldLine;
      if (lineNumber != null) {
        viewerRef.current?.scrollTo({
          type: "line",
          id: finding.filePath,
          lineNumber,
          side: finding.newLine != null ? "additions" : "deletions",
          align: "center",
          behavior: "smooth-auto",
        });
        return;
      }
      viewerRef.current?.scrollTo({ type: "item", id: finding.filePath, behavior: "smooth-auto" });
    }, 0);
  }

  async function copyMarkdown(): Promise<void> {
    if (!review) return;
    const markdown = review.findings
      .flatMap((finding) => formatFindingForMarkdown(finding))
      .join("\n");
    await navigator.clipboard.writeText(markdown);
    setMessage("Copied review markdown.");
  }
}

createRoot(document.getElementById("root")!).render(<App />);
