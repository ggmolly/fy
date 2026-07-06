import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CodeView as PierreCodeView } from "@pierre/diffs";
import { CodeView, type CodeViewHandle, type CodeViewItem, type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs/react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Code,
  Copy,
  Edit2,
  Eye,
  EyeOff,
  FileCheck2,
  FileText,
  FolderGit,
  Folder,
  FolderOpen,
  GitBranch,
  Image,
  Maximize2,
  MessageSquareReply,
  MessageSquarePlus,
  RefreshCw,
  Rows3,
  Search,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  ComparisonReviewState,
  DiffFileSummary,
  DiffResponse,
  GitRef,
  ReviewFinding,
  SessionMetadata,
  ViewedFileHashRecord,
} from "../shared/types";
import { mergeRemoteReview, sameReview } from "./reviewSync";
import "./styles.css";

type CodeViewLineSelection = { id: string; range: SelectedLineRange };
type LoadState = { status: "idle" | "loading" | "ready" | "empty" | "error"; message?: string };
type PreviewRefs = { baseRef?: string; targetRef?: string };
type SidebarFilter = "open" | "viewed" | "updated" | "comments" | "generated";
type PromptMode = "all" | "fixes" | "questions";
type ReviewLineAnnotation =
  | { kind: "finding"; finding: ReviewFinding }
  | { kind: "draft"; selection: CodeViewLineSelection }
  | { kind: "fileDraft"; file: DiffFileSummary }
  | { kind: "preview"; file: DiffFileSummary; refs: PreviewRefs };

function App(): React.JSX.Element {
  const viewerRef = useRef<CodeViewHandle<ReviewLineAnnotation>>(null);
  const editingFindingIdsRef = useRef<Set<string>>(new Set());
  const skipNextReviewSaveRef = useRef(false);
  const [session, setSession] = useState<SessionMetadata | null>(null);
  const [refs, setRefs] = useState<GitRef[]>([]);
  const [diff, setDiff] = useState<DiffResponse | null>(null);
  const [review, setReview] = useState<ComparisonReviewState | null>(null);
  const [viewedHashIndex, setViewedHashIndex] = useState<ViewedFileHashRecord[]>([]);
  const [autoViewRules, setAutoViewRules] = useState<string[]>([]);
  const [autoViewRulesDraft, setAutoViewRulesDraft] = useState("");
  const [baseRef, setBaseRef] = useState("origin/main");
  const [headRef, setHeadRef] = useState("HEAD");
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

  const loadRepo = useCallback(async () => {
    const [sessionResponse, refsResponse] = await Promise.all([
      api<SessionMetadata>("/api/session"),
      api<{ refs: GitRef[] }>("/api/git/refs"),
    ]);
    setSession(sessionResponse);
    setRefs(refsResponse.refs);
    setBaseRef(sessionResponse.defaultBase ?? sessionResponse.upstreamBranch ?? "origin/main");
    setHeadRef(sessionResponse.currentBranch ?? "HEAD");
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
    source.addEventListener("reload", markDiffStale);
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
    setLoadState({ status: "loading", message: "Loading diff..." });
    try {
      const query = params.toString();
      const nextDiff = await api<DiffResponse>(`/api/diff${query ? `?${query}` : ""}`);
      setDiff(nextDiff);
      const [nextReview, nextIndex, nextRules] = await Promise.all([
        api<ComparisonReviewState>(`/api/review?comparisonKey=${encodeURIComponent(expectedKey ?? nextDiff.comparisonKey)}`),
        api<{ viewedFileHashes: ViewedFileHashRecord[] }>("/api/review/viewed-index"),
        api<{ autoViewRules: string[] }>("/api/review/auto-view-rules"),
      ]);
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
            <select value={baseRef} onChange={(event) => setBaseRef(event.target.value)}>
              {refOptions.map((ref) => <option key={`${ref.kind}:${ref.name}`} value={ref.name}>{ref.name}</option>)}
            </select>
          </label>
          <span className="swapIcon">↔</span>
          <label className="selectLabel">
            <span>Head:</span>
            <select value={headRef} onChange={(event) => setHeadRef(event.target.value)}>
              {refOptions.map((ref) => <option key={`${ref.kind}:${ref.name}`} value={ref.name}>{ref.name}</option>)}
            </select>
          </label>
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

      <section className="workspace">
        <aside className="sidebar">
          <div className="panelHeader">
            <h2>Changed files</h2>
            <span>{diff?.files.length ?? 0}</span>
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
        </aside>

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

function FileList({
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

function ReviewProgress({ progress }: { progress: { files: number; viewed: number; openComments: number; outdatedComments: number; updatedFiles: number } }): React.JSX.Element {
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

function AutoViewRulesEditor({
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

function buildFileTree(files: DiffFileSummary[]): { nodes: FileTreeNode[]; files: DiffFileSummary[] } {
  const visibleFiles = files;
  const root: MutableFolder = { kind: "folder", path: "", name: "", children: new Map(), files: [] };

  for (const file of visibleFiles) {
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

  return { nodes: sortTreeNodes([...root.children.values()]).map(compactSingleFolder), files: visibleFiles };
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

function HeaderCollapseToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle(): void }): React.JSX.Element {
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

function HeaderMetadata({
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

function InlineFindingForm({
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

function InlineFileFindingForm({
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

function FloatingPanel({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }): React.JSX.Element {
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

function StateBanner({ state, onRetry }: { state: LoadState; onRetry(): void }): React.JSX.Element {
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

function FilePreview({ file, refs }: { file: DiffFileSummary; refs: PreviewRefs }): React.JSX.Element | null {
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

function ReviewAnnotation({
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

function formatSelectionLabel(selection: CodeViewLineSelection): string {
  const prefix = selection.range.side === "deletions" || selection.range.endSide === "deletions" ? "L" : "R";
  if (selection.range.start === selection.range.end) return `${prefix}${selection.range.end}`;
  return `${prefix}${selection.range.start} to ${prefix}${selection.range.end}`;
}

function getSelectedCode(file: DiffResponse["parsedFiles"][number] | undefined, selection: CodeViewLineSelection): string | undefined {
  if (!file) return undefined;
  const side = selection.range.endSide ?? selection.range.side;
  const source = side === "deletions" ? file.deletionLines : file.additionLines;
  const start = Math.min(selection.range.start, selection.range.end);
  const end = Math.max(selection.range.start, selection.range.end);
  return source.slice(Math.max(0, start - 1), end).join("\n");
}

function splitSuggestionBlocks(body: string): Array<{ kind: "text"; text: string } | { kind: "suggestion"; code: string }> {
  const parts: Array<{ kind: "text"; text: string } | { kind: "suggestion"; code: string }> = [];
  const pattern = /```suggestion\n([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    if (match.index > cursor) {
      parts.push({ kind: "text", text: body.slice(cursor, match.index).trim() });
    }
    parts.push({ kind: "suggestion", code: match[1]?.trimEnd() ?? "" });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) {
    parts.push({ kind: "text", text: body.slice(cursor).trim() });
  }
  return parts.length > 0 ? parts : [{ kind: "text", text: body }];
}

function formatFindingForPrompt(finding: ReviewFinding): string[] {
  const lines = [`- [${finding.id}] ${finding.filePath}${lineLabel(finding)} (${finding.author}):`];
  if (finding.selectedCode) {
    lines.push("  Original selected code:", ...indentBlock(finding.selectedCode, "  "));
  }
  lines.push(...indentBlock(formatCommentForPrompt(finding.comment), "  "));
  for (const reply of finding.replies) {
    lines.push(`  Reply from ${reply.author}:`, ...indentBlock(reply.body, "    "));
  }
  return lines;
}

function renderCodexPrompt(review: ComparisonReviewState, mode: PromptMode): string {
  const findings = review.findings
    .filter((finding) => finding.status === "open")
    .filter((finding) => {
      if (mode === "questions") return isQuestionFinding(finding);
      if (mode === "fixes") return !isQuestionFinding(finding);
      return true;
    });

  const lines = [
    mode === "questions"
      ? "Please answer these fy review questions in the current repository."
      : "Please address these fy review comments in the current repository.",
    "",
    "Use the `fy-review` Codex skill for this local fy review workflow.",
    "",
  ];

  if (mode === "questions") {
    lines.push(
      "Only answer the questions. Do not modify code for these items.",
      "Use the answer to challenge assumptions or brainstorm when useful.",
      "Use `fy agent reply <comment-id> --body \"...\"` for each answer.",
    );
  } else if (mode === "fixes") {
    lines.push(
      "Only change code for comments that clearly ask for a code change or identify a concrete bug.",
      "Questions are intentionally excluded from this prompt.",
      "Use `fy agent resolve <comment-id>` after fixing a concrete issue, or `fy agent resolve <comment-id> --body \"...\"` when a resolution note is useful.",
    );
  } else {
    lines.push(
      "Important: if a review comment is phrased as a question, answer it directly and do not modify code for that item. Use the answer to challenge assumptions or brainstorm when useful.",
      "Only change code for comments that clearly ask for a code change or identify a concrete bug.",
      "Use `fy agent reply <comment-id> --body \"...\"` to answer a question without changing code.",
      "Use `fy agent resolve <comment-id>` after fixing a concrete issue, or `fy agent resolve <comment-id> --body \"...\"` when a resolution note is useful.",
    );
  }

  lines.push(
    "",
    `Comparison: ${review.comparisonKey}`,
    "",
  );
  lines.push(...(findings.length > 0 ? findings.flatMap((finding) => formatFindingForPrompt(finding)) : ["No open comments match this prompt mode."]));
  return lines.join("\n");
}

function isQuestionFinding(finding: Pick<ReviewFinding, "comment" | "replies">): boolean {
  return [finding.comment, ...finding.replies.map((reply) => reply.body)].some((text) => text.trim().endsWith("?"));
}

function formatFindingForMarkdown(finding: ReviewFinding): string[] {
  const lines = [`### ${finding.filePath}${lineLabel(finding)}`, "", `- Status: ${finding.status}`, `- Author: ${finding.author}`, ""];
  if (finding.selectedCode) {
    lines.push("Original selected code:", "", "```", finding.selectedCode, "```", "");
  }
  lines.push(formatCommentForPrompt(finding.comment), "");
  for (const reply of finding.replies) {
    lines.push(`- ${reply.author}: ${reply.body}`);
  }
  return lines;
}

function formatCommentForPrompt(comment: string): string {
  return splitSuggestionBlocks(comment)
    .map((part) => (part.kind === "text" ? part.text : `Suggested replacement:\n\`\`\`\n${part.code}\n\`\`\``))
    .filter(Boolean)
    .join("\n\n");
}

function indentBlock(value: string, prefix: string): string[] {
  return value.split("\n").map((line) => `${prefix}${line}`);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

function lineLabel(finding: { oldLine?: number; newLine?: number; range?: SelectedLineRange }): string {
  if (finding.range) {
    const start = Math.min(finding.range.start, finding.range.end);
    const end = Math.max(finding.range.start, finding.range.end);
    return start === end ? `:${end}` : `:${start}-${end}`;
  }
  if (finding.newLine != null) return `:${finding.newLine}`;
  if (finding.oldLine != null) return `:${finding.oldLine}`;
  return "";
}

function getContext(file: DiffResponse["parsedFiles"][number] | undefined, selection: CodeViewLineSelection): string[] {
  if (!file) return [];
  const side = selection.range.endSide ?? selection.range.side;
  const line = selection.range.end;
  const source = side === "deletions" ? file.deletionLines : file.additionLines;
  return source.slice(Math.max(0, line - 3), line + 2);
}

function viewedHashKey(path: string, contentHash: string): string {
  return `${path}\0${contentHash}`;
}

function isPreviewableFile(path: string): boolean {
  return getPreviewKind(path) !== null;
}

function getPreviewKind(path: string): "image" | "markdown" | "notebook" | null {
  const lowered = path.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(lowered)) return "image";
  if (/\.(md|markdown)$/.test(lowered)) return "markdown";
  if (lowered.endsWith(".ipynb")) return "notebook";
  return null;
}

function parseAutoViewRules(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => normalizePath(line.trim())).filter(Boolean))];
}

function matchesAutoViewRules(path: string, rules: string[]): boolean {
  return rules.some((rule) => matchesAutoViewRule(path, rule));
}

function matchesAutoViewRule(path: string, rule: string): boolean {
  const normalizedRule = normalizePath(rule);
  const normalizedPath = normalizePath(path);
  if (!normalizedRule.includes("/")) {
    return matchesPathSegment(normalizedPath.split("/").pop() ?? normalizedPath, normalizedRule);
  }
  return matchesPathSegments(normalizedPath.split("/").filter(Boolean), normalizedRule.split("/").filter(Boolean));
}

function matchesPathSegments(pathSegments: string[], ruleSegments: string[], pathIndex = 0, ruleIndex = 0): boolean {
  const rule = ruleSegments[ruleIndex];
  if (!rule) return pathIndex >= pathSegments.length;
  if (rule === "**") {
    if (ruleIndex + 1 >= ruleSegments.length) return true;
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (matchesPathSegments(pathSegments, ruleSegments, nextPathIndex, ruleIndex + 1)) return true;
    }
    return false;
  }
  const segment = pathSegments[pathIndex];
  return Boolean(segment && matchesPathSegment(segment, rule) && matchesPathSegments(pathSegments, ruleSegments, pathIndex + 1, ruleIndex + 1));
}

function matchesPathSegment(value: string, rule: string): boolean {
  const regex = new RegExp(`^${rule.replace(/[|\\{}()[\]^$+.]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
  return regex.test(value);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function resolvePreviewRefs(comparisonKey: string): PreviewRefs {
  if (comparisonKey === "working" || comparisonKey === "staged") return { baseRef: "HEAD", targetRef: "working" };
  if (comparisonKey.endsWith("...working")) {
    return { baseRef: comparisonKey.slice(0, -"...working".length), targetRef: "working" };
  }
  if (comparisonKey.startsWith("commit-")) {
    const sha = comparisonKey.slice("commit-".length);
    return { baseRef: `${sha}^`, targetRef: sha };
  }
  if (comparisonKey.includes("...")) {
    const [baseRef, targetRef] = comparisonKey.split("...");
    return { baseRef, targetRef };
  }
  return { targetRef: "working" };
}

function blobUrl(path: string, ref: string): string {
  const params = new URLSearchParams({ path, ref });
  return `/api/blob?${params.toString()}`;
}

function parseWatchEvent(event: Event): { comparisonKey?: string } | null {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  try {
    const payload = JSON.parse(event.data) as { comparisonKey?: unknown };
    return typeof payload.comparisonKey === "string" ? { comparisonKey: payload.comparisonKey } : null;
  } catch {
    return null;
  }
}

function hashItemVersion(file: string, collapsed: boolean, hasDraft: boolean, findings: ReviewFinding[]): number {
  let hash = collapsed ? 17 : 31;
  hash = hash * 31 + (hasDraft ? 1 : 0);
  for (const value of [file, ...findings.map((finding) => `${finding.id}:${finding.updatedAt}:${finding.status}:${finding.comment}:${finding.replies.length}`)]) {
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 33 + value.charCodeAt(index)) >>> 0;
    }
  }
  return hash;
}

createRoot(document.getElementById("root")!).render(<App />);
