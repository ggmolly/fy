import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";

export type SourceMode = "working" | "staged" | "base" | "pr" | "patch";

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface GitHubRemoteMetadata {
  owner: string;
  repo: string;
  remote: string;
  url: string;
}

export interface SessionMetadata {
  sessionId: string;
  repoRoot: string;
  currentBranch: string | null;
  upstreamBranch: string | null;
  defaultBase: string | null;
  sourceMode: SourceMode;
  sourceLabel: string;
  comparisonKey: string;
  githubRemote: GitHubRemoteMetadata | null;
  pr?: {
    number: number;
    title?: string;
    headRefName?: string;
    baseRefName?: string;
    url?: string;
  };
}

export interface GitStatusFile {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  status: FileStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface GitBranch {
  name: string;
  kind: "local" | "remote";
  current: boolean;
  upstream?: string;
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl?: string;
}

export interface GitRef {
  name: string;
  kind: "head" | "upstream" | "local" | "remote" | "tag";
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
}

export interface DiffFileSummary {
  path: string;
  previousPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  contentHash: string;
  isGenerated: boolean;
  generatedReason?: string;
}

export interface DiffResponse {
  raw: string;
  comparisonKey: string;
  files: DiffFileSummary[];
  parsedFiles: FileDiffMetadata[];
}

export type FindingStatus = "open" | "resolved";

export interface ReviewReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewFinding {
  id: string;
  comparisonKey: string;
  filePath: string;
  fileContentHash?: string;
  oldLine?: number;
  newLine?: number;
  range?: SelectedLineRange;
  author: string;
  comment: string;
  status: FindingStatus;
  replies: ReviewReply[];
  selectedCode?: string;
  context?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ViewedFileRecord {
  path: string;
  contentHash: string;
  viewedAt: string;
}

export interface ViewedFileHashRecord {
  path: string;
  contentHash: string;
  viewedAt: string;
}

export interface ComparisonReviewState {
  comparisonKey: string;
  findings: ReviewFinding[];
  viewedFiles: ViewedFileRecord[];
  collapsedFiles: string[];
  expandedFiles: string[];
  layout: "split" | "unified";
  updatedAt: string;
}

export interface ReviewStore {
  version: 1;
  comparisons: Record<string, ComparisonReviewState>;
  viewedFileHashes: ViewedFileHashRecord[];
  autoViewRules: string[];
}

export interface ExportResponse {
  markdown: string;
  jsonPath: string;
  markdownPath: string;
}
