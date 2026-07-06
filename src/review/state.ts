import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  ComparisonReviewState,
  DiffResponse,
  ExportResponse,
  ReviewStore,
  SessionMetadata,
  ViewedFileHashRecord,
} from "../shared/types";
import type { SelectedLineRange } from "@pierre/diffs";

const replySchema = z.object({
  id: z.string().min(1),
  author: z.string().min(1),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const viewedFileSchema = z.object({
  path: z.string().min(1),
  contentHash: z.string().min(1),
  viewedAt: z.string(),
});

export const viewedFileHashIndexSchema = z.object({
  viewedFileHashes: z.array(viewedFileSchema),
});

export const autoViewRulesSchema = z.object({
  autoViewRules: z.array(z.string().trim().min(1)).max(200),
});

const findingSchema = z.object({
  id: z.string().min(1),
  comparisonKey: z.string().min(1),
  filePath: z.string().min(1),
  fileContentHash: z.string().min(1).optional(),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
  range: z
    .object({
      start: z.number().int(),
      side: z.enum(["deletions", "additions"]).optional(),
      end: z.number().int(),
      endSide: z.enum(["deletions", "additions"]).optional(),
    })
    .optional(),
  author: z.string().min(1).default("molly"),
  comment: z.string(),
  status: z.enum(["open", "resolved"]),
  replies: z.array(replySchema).default([]),
  selectedCode: z.string().optional(),
  context: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const comparisonReviewSchema = z.object({
  comparisonKey: z.string().min(1),
  findings: z.array(findingSchema),
  viewedFiles: z.array(viewedFileSchema),
  collapsedFiles: z.array(z.string()),
  expandedFiles: z.array(z.string()).default([]),
  layout: z.enum(["split", "unified"]),
  updatedAt: z.string(),
});

const storeSchema = z.object({
  version: z.literal(1),
  comparisons: z.record(z.string(), comparisonReviewSchema),
  viewedFileHashes: z.array(viewedFileSchema).default([]),
  autoViewRules: z.array(z.string()).default(defaultAutoViewRules()),
});

export async function loadReview(repoRoot: string, sessionId: string, comparisonKey: string): Promise<ComparisonReviewState> {
  void sessionId;
  const store = await loadReviewStore(repoRoot);
  return store.comparisons[comparisonKey] ?? createEmptyReview(comparisonKey);
}

export async function saveReview(repoRoot: string, sessionId: string, state: ComparisonReviewState): Promise<ComparisonReviewState> {
  void sessionId;
  const parsed = comparisonReviewSchema.parse(state);
  const store = await loadReviewStore(repoRoot);
  store.comparisons[parsed.comparisonKey] = parsed;
  await saveReviewStore(repoRoot, store);
  return parsed;
}

export async function loadViewedFileHashIndex(repoRoot: string): Promise<ViewedFileHashRecord[]> {
  return (await loadReviewStore(repoRoot)).viewedFileHashes;
}

export async function saveViewedFileHashIndex(repoRoot: string, records: ViewedFileHashRecord[]): Promise<ViewedFileHashRecord[]> {
  const parsed = viewedFileHashIndexSchema.parse({ viewedFileHashes: records }).viewedFileHashes;
  const store = await loadReviewStore(repoRoot);
  store.viewedFileHashes = trimViewedFileHashes(parsed);
  await saveReviewStore(repoRoot, store);
  return store.viewedFileHashes;
}

export async function loadAutoViewRules(repoRoot: string): Promise<string[]> {
  return (await loadReviewStore(repoRoot)).autoViewRules;
}

export async function saveAutoViewRules(repoRoot: string, rules: string[]): Promise<string[]> {
  const parsed = autoViewRulesSchema.parse({ autoViewRules: rules }).autoViewRules;
  const store = await loadReviewStore(repoRoot);
  store.autoViewRules = dedupeRules(parsed);
  await saveReviewStore(repoRoot, store);
  return store.autoViewRules;
}

export async function exportReview(
  repoRoot: string,
  session: SessionMetadata,
  review: ComparisonReviewState,
  diff: DiffResponse,
): Promise<ExportResponse> {
  const dir = exportDir(repoRoot, review.comparisonKey);
  await mkdir(dir, { recursive: true });
  const jsonPath = join(dir, "review.json");
  const markdownPath = join(dir, "review.md");
  const markdown = renderReviewMarkdown(session, review, diff);
  await writeFile(jsonPath, JSON.stringify({ session, review, files: diff.files }, null, 2));
  await writeFile(markdownPath, markdown);
  return { markdown, jsonPath, markdownPath };
}

function createEmptyReview(comparisonKey: string): ComparisonReviewState {
  return {
    comparisonKey,
    findings: [],
    viewedFiles: [],
    collapsedFiles: [],
    expandedFiles: [],
    layout: "split",
    updatedAt: new Date().toISOString(),
  };
}

export async function loadReviewStore(repoRoot: string): Promise<ReviewStore> {
  try {
    const raw = await readFile(statePath(repoRoot), "utf8");
    return storeSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { version: 1, comparisons: {}, viewedFileHashes: [], autoViewRules: defaultAutoViewRules() };
    }
    throw error;
  }
}

export async function saveReviewStore(repoRoot: string, store: ReviewStore): Promise<ReviewStore> {
  const parsed = storeSchema.parse(store);
  const dir = repoCacheDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const targetPath = statePath(repoRoot);
  const tempPath = join(dir, `.state-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(tempPath, JSON.stringify(parsed, null, 2));
  await rename(tempPath, targetPath);
  return parsed;
}

export function repoCacheDir(repoRoot: string): string {
  return join(cacheRoot(), "repos", hashKey(repoRoot));
}

function exportDir(repoRoot: string, comparisonKey: string): string {
  return join(repoCacheDir(repoRoot), "exports", hashKey(comparisonKey));
}

function statePath(repoRoot: string): string {
  return join(repoCacheDir(repoRoot), "state.json");
}

function cacheRoot(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "fy");
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function trimViewedFileHashes(records: ViewedFileHashRecord[]): ViewedFileHashRecord[] {
  const byKey = new Map<string, ViewedFileHashRecord>();
  for (const record of records) {
    byKey.set(`${record.path}\0${record.contentHash}`, record);
  }
  return [...byKey.values()]
    .sort((a, b) => (a.viewedAt < b.viewedAt ? 1 : -1))
    .slice(0, 2000);
}

function defaultAutoViewRules(): string[] {
  return [
    "bun.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "*.snap",
    "*.Designer.cs",
    "*.generated.*",
    "*.g.cs",
    "**/Migrations/**",
  ];
}

function dedupeRules(rules: string[]): string[] {
  return [...new Set(rules.map((rule) => rule.trim()).filter(Boolean))];
}

function renderReviewMarkdown(session: SessionMetadata, review: ComparisonReviewState, diff: DiffResponse): string {
  const lines: string[] = [
    `# fy review: ${review.comparisonKey}`,
    "",
    "## Metadata",
    "",
    `- Repo: ${session.repoRoot}`,
    `- Source: ${session.sourceLabel}`,
    `- Comparison: ${review.comparisonKey}`,
    `- Current branch: ${session.currentBranch ?? "unknown"}`,
    `- Files changed: ${diff.files.length}`,
    "",
    "## Summary",
    "",
    `- Open findings: ${review.findings.filter((finding) => finding.status === "open").length}`,
    `- Resolved findings: ${review.findings.filter((finding) => finding.status === "resolved").length}`,
    "",
    "## Findings",
    "",
  ];

  for (const finding of [...review.findings].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
    lines.push(`### ${finding.filePath}${formatLine(finding)}`, "");
    lines.push(`- Status: ${finding.status}`);
    lines.push(`- Author: ${finding.author}`);
    lines.push("");
    lines.push(finding.comment || "_No comment._", "");
    if (finding.selectedCode) {
      lines.push("Selected code:", "", "```", finding.selectedCode, "```", "");
    }
    if (finding.replies.length > 0) {
      lines.push("Replies:", "");
      for (const reply of finding.replies) {
        lines.push(`- ${reply.author}: ${reply.body || "_No reply body._"}`);
      }
      lines.push("");
    }
    if (finding.context && finding.context.length > 0) {
      lines.push("```", ...finding.context, "```", "");
    }
  }

  if (review.findings.length === 0) lines.push("_No findings._", "");
  return lines.join("\n");
}

function formatLine(finding: { oldLine?: number; newLine?: number; range?: SelectedLineRange }): string {
  if (finding.range) {
    const start = Math.min(finding.range.start, finding.range.end);
    const end = Math.max(finding.range.start, finding.range.end);
    return start === end ? `:${end}` : `:${start}-${end}`;
  }
  if (finding.newLine != null) return `:${finding.newLine}`;
  if (finding.oldLine != null) return `:${finding.oldLine}`;
  return "";
}
