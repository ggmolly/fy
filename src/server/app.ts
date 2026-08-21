import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { z } from "zod";
import { execa } from "execa";
import {
  acquireDiff,
  getBranches,
  getCommits,
  getRefs,
  getRemotes,
  getSessionMetadata,
  getStatus,
  GitUserError,
  type RepoContext,
} from "../git/git";
import {
  comparisonReviewSchema,
  autoViewRulesSchema,
  exportReview,
  loadAutoViewRules,
  loadReview,
  loadViewedFileHashIndex,
  saveAutoViewRules,
  saveReview,
  saveViewedFileHashIndex,
  viewedFileHashIndexSchema,
} from "../review/state";

const commitsQuerySchema = z.object({
  ref: z.string().min(1).default("HEAD"),
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

const blobQuerySchema = z.object({
  path: z.string().min(1),
  ref: z.string().min(1).optional(),
});

const openInEditorSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
});

export function createApp(repo: RepoContext): Hono {
  const app = new Hono();

  app.get("/api/session", async (c) => {
    repo.session = await getSessionMetadata(repo.repoRoot, repo.sessionId, repo.initialSource);
    return c.json(repo.session);
  });

  app.get("/api/git/status", async (c) => c.json({ files: await getStatus(repo.repoRoot) }));
  app.get("/api/git/branches", async (c) => c.json(await getBranches(repo.repoRoot)));
  app.get("/api/git/remotes", async (c) => c.json({ remotes: await getRemotes(repo.repoRoot) }));
  app.get("/api/git/refs", async (c) => c.json({ refs: await getRefs(repo.repoRoot) }));
  app.get("/api/git/commits", async (c) => {
    const query = commitsQuerySchema.parse(c.req.query());
    return c.json({ commits: await getCommits(repo.repoRoot, query.ref, query.limit) });
  });

  app.get("/api/diff", async (c) => c.json(await acquireDiff(repo, new URL(c.req.url).searchParams)));
  app.get("/api/files", async (c) => {
    const diff = await acquireDiff(repo, new URL(c.req.url).searchParams);
    return c.json({ comparisonKey: diff.comparisonKey, files: diff.files });
  });
  app.get("/api/watch", async (c) => {
    const params = new URL(c.req.url).searchParams;
    const signal = c.req.raw.signal;
    const encoder = new TextEncoder();
    let lastDiffHash = "";
    let lastReviewHash = "";
    let stopped = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, payload: unknown): void => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        };
        const tick = async (): Promise<void> => {
          if (stopped) return;
          try {
            const diff = await acquireDiff(repo, params);
            const changedAt = new Date().toISOString();
            const nextDiffHash = hashWatchPayload(diff.comparisonKey, diff.raw);
            if (lastDiffHash && nextDiffHash !== lastDiffHash) {
              const payload = { comparisonKey: diff.comparisonKey, changedAt };
              send("diff-changed", payload);
            }
            lastDiffHash = nextDiffHash;

            const review = await loadReview(repo.repoRoot, diff.comparisonKey);
            const nextReviewHash = hashJsonPayload(review);
            if (lastReviewHash && nextReviewHash !== lastReviewHash) {
              send("review-changed", { comparisonKey: review.comparisonKey, updatedAt: review.updatedAt, changedAt });
            }
            lastReviewHash = nextReviewHash;
          } catch (error) {
            send("watch-error", { error: error instanceof Error ? error.message : "watch failed" });
          }
        };
        await tick();
        send("ready", { watching: params.toString() || "initial" });
        const timer = setInterval(() => void tick(), 1000);
        signal.addEventListener("abort", () => {
          stopped = true;
          clearInterval(timer);
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });
  app.get("/api/file", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "invalid file path" }, 400);
    validateRepoRelativePath(repo.repoRoot, path);
    const diff = await acquireDiff(repo, new URL(c.req.url).searchParams);
    const file = diff.parsedFiles.find((candidate) => candidate.name === path);
    return file ? c.json({ file }) : c.json({ error: "file not found in current diff" }, 404);
  });

  app.get("/api/blob", async (c) => {
    const query = blobQuerySchema.parse(c.req.query());
    const file = validateRepoRelativePath(repo.repoRoot, query.path);
    const body =
      query.ref && query.ref !== "working"
        ? await readGitBlob(repo.repoRoot, query.ref, query.path)
        : await readFile(file.absolutePath);
    return new Response(toArrayBuffer(body), {
      headers: { "content-type": contentType(query.path) },
    });
  });

  app.get("/api/review", async (c) => {
    const comparisonKey = c.req.query("comparisonKey") ?? repo.session.comparisonKey;
    return c.json(await loadReview(repo.repoRoot, comparisonKey));
  });

  app.post("/api/review", async (c) => {
    const body = comparisonReviewSchema.parse(await c.req.json());
    return c.json(await saveReview(repo.repoRoot, body));
  });

  app.get("/api/review/viewed-index", async (c) => c.json({ viewedFileHashes: await loadViewedFileHashIndex(repo.repoRoot) }));

  app.post("/api/review/viewed-index", async (c) => {
    const body = viewedFileHashIndexSchema.parse(await c.req.json());
    return c.json({ viewedFileHashes: await saveViewedFileHashIndex(repo.repoRoot, body.viewedFileHashes) });
  });

  app.get("/api/review/auto-view-rules", async (c) => c.json({ autoViewRules: await loadAutoViewRules(repo.repoRoot) }));

  app.post("/api/review/auto-view-rules", async (c) => {
    const body = autoViewRulesSchema.parse(await c.req.json());
    return c.json({ autoViewRules: await saveAutoViewRules(repo.repoRoot, body.autoViewRules) });
  });

  app.post("/api/open-in-editor", async (c) => {
    const body = openInEditorSchema.parse(await c.req.json());
    const file = validateRepoRelativePath(repo.repoRoot, body.path);
    openInEditor(file.absolutePath, body.line);
    return c.json({ ok: true });
  });

  app.post("/api/export", async (c) => {
    const body = z.object({ comparisonKey: z.string().min(1) }).parse(await c.req.json().catch(() => ({})));
    const params = paramsFromComparisonKey(body.comparisonKey);
    const diff = await acquireDiff(repo, params);
    const review = await loadReview(repo.repoRoot, body.comparisonKey);
    return c.json(await exportReview(repo.repoRoot, repo.session, review, diff));
  });

  app.get("*", async (c) => {
    const staticRoot = findStaticRoot();
    if (!staticRoot) {
      return c.text("UI has not been built. Run `bun run build` first.", 503);
    }
    const url = new URL(c.req.url);
    const safePath = resolve(staticRoot, `.${url.pathname}`);
    if (!safePath.startsWith(staticRoot)) {
      return c.text("not found", 404);
    }
    const filePath = (await isFile(safePath)) ? safePath : join(staticRoot, "index.html");
    return new Response(await readFile(filePath), {
      headers: { "content-type": contentType(filePath) },
    });
  });

  app.onError((error, c) => {
    if (error instanceof GitUserError || error instanceof z.ZodError) {
      return c.json({ error: error.message }, 400);
    }
    console.error(error);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}

function validateRepoRelativePath(repoRoot: string, rawPath: string): { relativePath: string; absolutePath: string } {
  if (rawPath.startsWith("/") || rawPath.includes("\0") || rawPath.split(/[\\/]+/).includes("..")) {
    throw new GitUserError(`invalid file path: ${rawPath}`);
  }
  const absolutePath = resolve(repoRoot, rawPath);
  if (absolutePath !== repoRoot && !absolutePath.startsWith(`${repoRoot}${sep}`)) {
    throw new GitUserError(`invalid file path: ${rawPath}`);
  }
  return { relativePath: rawPath, absolutePath };
}

async function readGitBlob(repoRoot: string, ref: string, path: string): Promise<Uint8Array> {
  assertSafeBlobRef(ref);
  const { stdout } = await execa("git", ["show", `${ref}:${path}`], {
    cwd: repoRoot,
    encoding: "buffer",
    reject: true,
  }).catch((error) => {
    throw new GitUserError(`git command failed: ${(error as { shortMessage?: string; message?: string }).shortMessage ?? (error as Error).message}`);
  });
  return stdout;
}

function assertSafeBlobRef(ref: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}~^+-]*$/.test(ref) || ref.startsWith("-") || ref.includes("..") || ref.includes("\\")) {
    throw new GitUserError(`invalid git ref: ${ref}`);
  }
}

function openInEditor(absolutePath: string, line?: number): void {
  const editor = process.env.FY_EDITOR || process.env.EDITOR || "code";
  const [command, ...baseArgs] = editor.split(/\s+/).filter(Boolean);
  const commandName = command.split(/[\\/]/).pop() ?? command;
  const target = line ? `${absolutePath}:${line}` : absolutePath;
  const args = commandName === "code" || commandName === "codium" ? [...baseArgs, "--goto", target] : [...baseArgs, target];
  Bun.spawn([command, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}

function toArrayBuffer(body: Uint8Array): ArrayBuffer {
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

function findStaticRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "dist/ui"),
    resolve(here, "../../dist/ui"),
    resolve(here, "../ui"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ?? null;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".md":
    case ".markdown":
    case ".json":
    case ".ipynb":
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function hashWatchPayload(comparisonKey: string, rawDiff: string): string {
  return createHash("sha256").update(comparisonKey).update("\0").update(rawDiff).digest("hex");
}

function hashJsonPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function paramsFromComparisonKey(comparisonKey: string): URLSearchParams {
  const params = new URLSearchParams();
  if (comparisonKey === "working" || comparisonKey === "working-no-untracked") {
    params.set("working", "true");
    if (comparisonKey === "working-no-untracked") params.set("untracked", "false");
  } else if (comparisonKey === "staged") {
    params.set("staged", "true");
  } else if (comparisonKey.startsWith("commit-")) {
    params.set("commit", comparisonKey.slice("commit-".length));
  } else if (comparisonKey.endsWith("...working") || comparisonKey.endsWith("...working-no-untracked")) {
    const suffix = comparisonKey.endsWith("...working-no-untracked") ? "...working-no-untracked" : "...working";
    params.set("base", comparisonKey.slice(0, -suffix.length));
    params.set("working", "true");
    if (suffix === "...working-no-untracked") params.set("untracked", "false");
  } else if (comparisonKey.includes("...")) {
    const [base, head] = comparisonKey.split("...");
    if (base) params.set("base", base);
    if (head) params.set("head", head);
  }
  return params;
}
