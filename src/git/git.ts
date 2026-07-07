import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { execa, type Options } from "execa";
import type {
  DiffResponse,
  GitBranch,
  GitCommit,
  GitHubRemoteMetadata,
  GitRef,
  GitRemote,
  GitStatusFile,
  SessionMetadata,
  SourceMode,
} from "../shared/types";
import { parseDiff, summarizeDiff } from "./diffParser";

export interface InitialSource {
  mode: SourceMode;
  base?: string;
  pr?: number;
  patchPath?: string;
}

export interface RepoContext {
  repoRoot: string;
  sessionId: string;
  initialSource: InitialSource;
  session: SessionMetadata;
}

export class GitUserError extends Error {}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]*$/;
const SHA_RE = /^[a-f0-9]{7,40}$/i;

export async function createRepoContext(repoPath: string, initialSource: InitialSource): Promise<RepoContext> {
  const rootInput = resolve(repoPath);
  const root = await git(["rev-parse", "--show-toplevel"], { cwd: rootInput }).catch((error) => {
    throw new GitUserError(`not a git repo: ${repoPath}\n${error.shortMessage ?? error.message}`);
  });
  const repoRoot = await realpath(root.stdout.trim());
  await git(["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });

  const sessionId = createHash("sha256").update(`${repoRoot}:${initialSource.mode}`).digest("hex").slice(0, 16);
  const session = await getSessionMetadata(repoRoot, sessionId, initialSource);
  return { repoRoot, sessionId, initialSource, session };
}

export async function getSessionMetadata(
  repoRoot: string,
  sessionId: string,
  initialSource: InitialSource,
): Promise<SessionMetadata> {
  const [currentBranch, upstreamBranch, defaultBase, githubRemote, pr] = await Promise.all([
    getCurrentBranch(repoRoot),
    getUpstreamBranch(repoRoot),
    getDefaultBase(repoRoot),
    getGitHubRemote(repoRoot),
    initialSource.mode === "pr" && initialSource.pr != null ? getPrMetadata(repoRoot, initialSource.pr) : Promise.resolve(undefined),
  ]);

  return {
    sessionId,
    repoRoot,
    currentBranch,
    upstreamBranch,
    defaultBase,
    sourceMode: initialSource.mode,
    sourceLabel: getSourceLabel(initialSource),
    comparisonKey: getInitialComparisonKey(initialSource, defaultBase),
    githubRemote,
    pr,
  };
}

export async function getStatus(repoRoot: string): Promise<GitStatusFile[]> {
  const { stdout } = await git(["status", "--porcelain=v1", "-z"], { cwd: repoRoot });
  const records = stdout.split("\0").filter(Boolean);
  const files: GitStatusFile[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    const path = record.slice(3);
    const originalPath = indexStatus === "R" || worktreeStatus === "R" ? records[index + 1] : undefined;
    if (originalPath) index += 1;
    files.push({
      path,
      originalPath,
      indexStatus,
      worktreeStatus,
      status: mapPorcelainStatus(indexStatus, worktreeStatus),
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: worktreeStatus !== " " || indexStatus === "?",
    });
  }
  return files;
}

export async function getBranches(repoRoot: string): Promise<{ branches: GitBranch[]; current: string | null; upstream: string | null }> {
  const { stdout } = await git(
    ["for-each-ref", "--format=%(refname:short)%09%(refname)%09%(upstream:short)", "refs/heads", "refs/remotes"],
    { cwd: repoRoot },
  );
  const current = await getCurrentBranch(repoRoot);
  const upstream = await getUpstreamBranch(repoRoot);
  const branches = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", fullName = "", branchUpstream = ""] = line.split("\t");
      return {
        name,
        kind: fullName.startsWith("refs/remotes/") ? "remote" : "local",
        current: name === current,
        upstream: branchUpstream || undefined,
      } satisfies GitBranch;
    });

  return { branches, current, upstream };
}

export async function getRemotes(repoRoot: string): Promise<GitRemote[]> {
  const { stdout } = await git(["remote", "-v"], { cwd: repoRoot });
  const byName = new Map<string, GitRemote>();
  for (const line of stdout.split("\n").filter(Boolean)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
    if (!match) continue;
    const [, name, url, kind] = match;
    const remote = byName.get(name) ?? { name, fetchUrl: url };
    if (kind === "fetch") remote.fetchUrl = url;
    if (kind === "push") remote.pushUrl = url;
    byName.set(name, remote);
  }
  return [...byName.values()];
}

export async function getRefs(repoRoot: string): Promise<GitRef[]> {
  const [branches, tags, current, upstream] = await Promise.all([
    getBranches(repoRoot),
    git(["tag", "--list"], { cwd: repoRoot }),
    getCurrentBranch(repoRoot),
    getUpstreamBranch(repoRoot),
  ]);
  const refs: GitRef[] = [{ name: "HEAD", kind: "head" }];
  if (upstream) refs.push({ name: upstream, kind: "upstream" });
  refs.push(
    ...branches.branches.map((branch): GitRef => ({
      name: branch.name,
      kind: branch.name === current ? "head" : branch.kind,
    })),
  );
  refs.push(...tags.stdout.split("\n").filter(Boolean).map((name) => ({ name, kind: "tag" as const })));
  return dedupeRefs(refs);
}

export async function getCommits(repoRoot: string, ref: string, limit: number): Promise<GitCommit[]> {
  assertSafeRef(ref);
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  const { stdout } = await git(
    ["log", ref, `--max-count=${boundedLimit}`, "--format=%H%x09%h%x09%s%x09%an%x09%ae%x09%aI"],
    { cwd: repoRoot },
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", shortSha = "", subject = "", authorName = "", authorEmail = "", authorDate = ""] = line.split("\t");
      return { sha, shortSha, subject, authorName, authorEmail, authorDate };
    });
}

export async function acquireDiff(repo: RepoContext, params: URLSearchParams): Promise<DiffResponse> {
  const source = await resolveDiffSource(repo, params);
  const raw = source.raw ?? (await runDiffCommand(repo.repoRoot, source.args));
  const parsedFiles = parseDiff(raw, `${repo.sessionId}:${source.key}`);
  return {
    raw,
    comparisonKey: source.key,
    files: summarizeDiff(raw, parsedFiles),
    parsedFiles,
  };
}

async function resolveDiffSource(repo: RepoContext, params: URLSearchParams): Promise<{ key: string; args: string[]; raw?: string }> {
  const base = params.get("base");
  const head = params.get("head");
  const commit = params.get("commit");
  const working = params.get("working") === "true";
  const staged = params.get("staged") === "true";

  if ([Boolean(commit), staged, working, Boolean(base || head)].filter(Boolean).length > 1 && !(base && working && !head)) {
    throw new GitUserError("choose one diff mode: commit, staged, working, or base/head");
  }

  if (commit) {
    assertSha(commit);
    return { key: `commit-${commit}`, args: ["show", "--format=fuller", "--patch", commit] };
  }
  if (staged) return { key: "staged", args: ["diff", "--staged"] };
  if (working && base) {
    assertSafeRef(base);
    return { key: `${base}...working`, args: [], raw: await getWorkingTreeDiff(repo.repoRoot, base) };
  }
  if (working) return { key: "working", args: [], raw: await getWorkingTreeDiff(repo.repoRoot) };
  if (base && head) {
    assertSafeRef(base);
    assertSafeRef(head);
    return { key: `${base}...${head}`, args: ["diff", `${base}...${head}`] };
  }

  return getInitialDiffSource(repo);
}

async function getInitialDiffSource(repo: RepoContext): Promise<{ key: string; args: string[]; raw?: string }> {
  const { initialSource } = repo;
  if (initialSource.mode === "staged") return { key: "staged", args: ["diff", "--staged"] };
  if (initialSource.mode === "base") {
    const base = initialSource.base ?? repo.session.defaultBase ?? "origin/main";
    assertSafeRef(base);
    return { key: `${base}...HEAD`, args: ["diff", `${base}...HEAD`] };
  }
  if (initialSource.mode === "pr") {
    if (initialSource.pr == null) throw new GitUserError("missing PR number");
    return { key: `pr-${initialSource.pr}`, args: ["pr", "diff", String(initialSource.pr), "--patch"] };
  }
  if (initialSource.mode === "patch") {
    if (!initialSource.patchPath) throw new GitUserError("missing patch path");
    return { key: `patch-${initialSource.patchPath}`, args: [], raw: await Bun.file(initialSource.patchPath).text() };
  }
  return { key: "working", args: [], raw: await getWorkingTreeDiff(repo.repoRoot) };
}

async function runDiffCommand(repoRoot: string, args: string[]): Promise<string> {
  const command = args[0] === "pr" ? "gh" : "git";
  const commandArgs = command === "gh" ? args : args;
  try {
    const { stdout } = await execa(command, commandArgs, { cwd: repoRoot, reject: true });
    return stdout;
  } catch (error) {
    throw commandError(command, error);
  }
}

async function getWorkingTreeDiff(repoRoot: string, base?: string): Promise<string> {
  const [trackedDiff, untrackedFiles] = await Promise.all([
    runDiffCommand(repoRoot, base ? ["diff", base] : ["diff"]),
    git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repoRoot }),
  ]);
  const untrackedDiffs = await Promise.all(
    untrackedFiles.stdout.split("\0").filter(Boolean).map((path) => getUntrackedFileDiff(repoRoot, path)),
  );
  return [trackedDiff, ...untrackedDiffs].filter((part) => part.trim() !== "").join("\n");
}

async function getUntrackedFileDiff(repoRoot: string, path: string): Promise<string> {
  const result = await execa("git", ["diff", "--no-index", "--", "/dev/null", path], { cwd: repoRoot, reject: false });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new GitUserError(`git failed: ${result.stderr || result.stdout || `unexpected exit code ${result.exitCode}`}`);
  }
  return result.stdout;
}

async function git(args: string[], options: Options): Promise<{ stdout: string }> {
  try {
    const result = await execa("git", args, { ...options, reject: true });
    return { stdout: String(result.stdout ?? "") };
  } catch (error) {
    throw commandError("git", error);
  }
}

function commandError(command: "git" | "gh", error: unknown): GitUserError {
  const maybe = error as { shortMessage?: string; stderr?: string; message?: string };
  const stderr = maybe.stderr ? `\n${maybe.stderr}` : "";
  if (command === "gh" && `${maybe.stderr ?? maybe.message ?? ""}`.toLowerCase().includes("authentication")) {
    return new GitUserError(`gh is not authenticated${stderr}`);
  }
  return new GitUserError(`${command} command failed: ${maybe.shortMessage ?? maybe.message ?? "unknown error"}${stderr}`);
}

function assertSafeRef(ref: string): void {
  if (!REF_RE.test(ref) || ref.startsWith("-") || ref.includes("..") || ref.includes("\\")) {
    throw new GitUserError(`invalid git ref: ${ref}`);
  }
}

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) {
    throw new GitUserError(`invalid commit sha: ${sha}`);
  }
}

async function getCurrentBranch(repoRoot: string): Promise<string | null> {
  const result = await git(["branch", "--show-current"], { cwd: repoRoot }).catch(() => ({ stdout: "" }));
  return result.stdout.trim() || null;
}

async function getUpstreamBranch(repoRoot: string): Promise<string | null> {
  const result = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: repoRoot }).catch(() => ({ stdout: "" }));
  return result.stdout.trim() || null;
}

async function getDefaultBase(repoRoot: string): Promise<string | null> {
  const result = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repoRoot }).catch(() => ({ stdout: "" }));
  return result.stdout.trim().replace(/^origin\//, "origin/") || null;
}

async function getGitHubRemote(repoRoot: string): Promise<GitHubRemoteMetadata | null> {
  const remotes = await getRemotes(repoRoot).catch(() => []);
  for (const remote of remotes) {
    const parsed = parseGitHubRemote(remote.fetchUrl);
    if (parsed) return { ...parsed, remote: remote.name, url: remote.fetchUrl };
  }
  return null;
}

function parseGitHubRemote(url: string): Pick<GitHubRemoteMetadata, "owner" | "repo"> | null {
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

async function getPrMetadata(repoRoot: string, pr: number): Promise<SessionMetadata["pr"]> {
  const { stdout } = await execa("gh", ["pr", "view", String(pr), "--json", "title,number,headRefName,baseRefName,url"], {
    cwd: repoRoot,
    reject: true,
  }).catch((error) => {
    throw commandError("gh", error);
  });
  return JSON.parse(stdout) as NonNullable<SessionMetadata["pr"]>;
}

function getSourceLabel(source: InitialSource): string {
  if (source.mode === "base") return `base ${source.base ?? "default"}...HEAD`;
  if (source.mode === "pr") return `PR #${source.pr}`;
  if (source.mode === "patch") return `patch ${source.patchPath}`;
  return source.mode;
}

function getInitialComparisonKey(source: InitialSource, defaultBase: string | null): string {
  if (source.mode === "base") return `${source.base ?? defaultBase ?? "origin/main"}...HEAD`;
  if (source.mode === "pr") return `pr-${source.pr}`;
  if (source.mode === "patch") return `patch-${source.patchPath}`;
  return source.mode;
}

function mapPorcelainStatus(indexStatus: string, worktreeStatus: string): GitStatusFile["status"] {
  if (indexStatus === "A" || worktreeStatus === "A" || indexStatus === "?") return "added";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus === "R" || worktreeStatus === "R") return "renamed";
  return "modified";
}

function dedupeRefs(refs: GitRef[]): GitRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
