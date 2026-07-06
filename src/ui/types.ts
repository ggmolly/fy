import type { SelectedLineRange } from "@pierre/diffs/react";
import type { DiffFileSummary, ReviewFinding } from "../shared/types";

export type CodeViewLineSelection = { id: string; range: SelectedLineRange };
export type LoadState = { status: "idle" | "loading" | "ready" | "empty" | "error"; message?: string };
export type PreviewRefs = { baseRef?: string; targetRef?: string };
export type SidebarFilter = "open" | "viewed" | "updated" | "comments" | "generated";
export type PromptMode = "all" | "fixes" | "questions";
export type ReviewLineAnnotation =
  | { kind: "finding"; finding: ReviewFinding }
  | { kind: "draft"; selection: CodeViewLineSelection }
  | { kind: "fileDraft"; file: DiffFileSummary }
  | { kind: "preview"; file: DiffFileSummary; refs: PreviewRefs };
