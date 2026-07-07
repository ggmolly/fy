import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { execa } from "execa";
import { createRepoContext } from "../src/git/git";
import { repoCacheDir } from "../src/review/state";
import { createApp } from "../src/server/app";
import type { ComparisonReviewState, DiffResponse, GitStatusFile } from "../src/shared/types";

describe("smoke", () => {
  test("serves status and working diff for a temp repo", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "fy-smoke-"));
    process.env.XDG_CACHE_HOME = await mkdtemp(join(tmpdir(), "fy-cache-"));
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test User"]);
    await writeFile(join(repoPath, "README.md"), "hello\n");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await writeFile(join(repoPath, "README.md"), "hello\nworld\n");
    await writeFile(join(repoPath, "a name.txt"), "space path\n");
    await git(repoPath, ["add", "a name.txt"]);
    await writeFile(join(repoPath, "notes.txt"), "draft\n");

    const repo = await createRepoContext(repoPath, { mode: "working" });
    const app = createApp(repo);

    const statusResponse = await app.request("/api/git/status");
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as { files: GitStatusFile[] };
    expect(status.files.some((file) => file.path === "README.md" && file.unstaged)).toBe(true);
    expect(status.files.some((file) => file.path === "a name.txt" && file.staged)).toBe(true);

    const diffResponse = await app.request("/api/diff?working=true");
    expect(diffResponse.status).toBe(200);
    const diff = (await diffResponse.json()) as DiffResponse;
    expect(diff.raw).toContain("+world");
    expect(diff.raw).toContain("+draft");
    expect(diff.files).toHaveLength(2);
    expect(diff.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "README.md",
        additions: 1,
        deletions: 0,
        contentHash: expect.any(String),
        isGenerated: false,
      }),
      expect.objectContaining({
        path: "notes.txt",
        status: "added",
        additions: 1,
        deletions: 0,
        contentHash: expect.any(String),
        isGenerated: false,
      }),
    ]));
    expect(diff.files.every((file) => file.contentHash !== "")).toBe(true);

    const blobResponse = await app.request("/api/blob?path=README.md&ref=working");
    expect(blobResponse.status).toBe(200);
    expect(await blobResponse.text()).toBe("hello\nworld\n");

    const traversalResponse = await app.request("/api/blob?path=../README.md&ref=working");
    expect(traversalResponse.status).toBe(400);

    const editorTraversalResponse = await app.request("/api/open-in-editor", {
      method: "POST",
      body: JSON.stringify({ path: "../README.md" }),
      headers: { "content-type": "application/json" },
    });
    expect(editorTraversalResponse.status).toBe(400);

    const viewedIndexResponse = await app.request("/api/review/viewed-index", {
      method: "POST",
      body: JSON.stringify({
        viewedFileHashes: [{ path: "README.md", contentHash: diff.files[0]?.contentHash, viewedAt: new Date().toISOString() }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(viewedIndexResponse.status).toBe(200);

    const autoRulesResponse = await app.request("/api/review/auto-view-rules", {
      method: "POST",
      body: JSON.stringify({ autoViewRules: ["*.snap", "README.md"] }),
      headers: { "content-type": "application/json" },
    });
    expect(autoRulesResponse.status).toBe(200);
    expect(await autoRulesResponse.json()).toEqual({ autoViewRules: ["*.snap", "README.md"] });

    const review: ComparisonReviewState = {
      comparisonKey: "working",
      findings: [
        {
          id: "finding-1",
          comparisonKey: "working",
          filePath: "README.md",
          newLine: 2,
          author: "molly",
          comment: "check this",
          status: "open",
          replies: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      viewedFiles: [],
      collapsedFiles: [],
      expandedFiles: [],
      layout: "split",
      updatedAt: new Date().toISOString(),
    };
    const saveResponse = await app.request("/api/review", {
      method: "POST",
      body: JSON.stringify(review),
      headers: { "content-type": "application/json" },
    });
    expect(saveResponse.status).toBe(200);

    const abort = new AbortController();
    const watchResponse = await app.request("/api/watch?working=true", { signal: abort.signal });
    expect(watchResponse.status).toBe(200);
    expect(watchResponse.body).not.toBeNull();
    const watch = createSseReader(watchResponse.body!);

    try {
      await watch.next("ready");

      await writeFile(join(repoPath, "README.md"), "hello\nworld\nagain\n");
      const diffEvent = await watch.next("diff-changed");
      expect(diffEvent.data).toEqual(expect.objectContaining({ comparisonKey: "working", changedAt: expect.any(String) }));

      const nextReview = {
        ...review,
        findings: [{ ...review.findings[0]!, status: "resolved" as const, updatedAt: new Date().toISOString() }],
        updatedAt: new Date().toISOString(),
      };
      const reviewResponse = await app.request("/api/review", {
        method: "POST",
        body: JSON.stringify(nextReview),
        headers: { "content-type": "application/json" },
      });
      expect(reviewResponse.status).toBe(200);
      const reviewEvent = await watch.next("review-changed");
      expect(reviewEvent.data).toEqual(expect.objectContaining({ comparisonKey: "working", updatedAt: nextReview.updatedAt, changedAt: expect.any(String) }));
    } finally {
      abort.abort();
      watch.reader.releaseLock();
    }

    expect(existsSync(join(repoPath, ".fy"))).toBe(false);
    expect(existsSync(join(repoCacheDir(repo.repoRoot), "state.json"))).toBe(true);
  });
});

function createSseReader(body: ReadableStream<Uint8Array>): {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  next(eventName: string): Promise<{ event: string; data: unknown }>;
} {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    reader,
    async next(eventName: string): Promise<{ event: string; data: unknown }> {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const event = readBufferedEvent();
        if (event) {
          if (event.event === eventName) return event;
          continue;
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${eventName}`)), 5000)),
        ]);
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      throw new Error(`timed out waiting for ${eventName}`);
    },
  };

  function readBufferedEvent(): { event: string; data: unknown } | null {
    const end = buffer.indexOf("\n\n");
    if (end === -1) return null;
    const raw = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const event = raw.match(/^event: (.+)$/m)?.[1];
    const data = raw.match(/^data: (.+)$/m)?.[1];
    if (!event || !data) return null;
    return { event, data: JSON.parse(data) as unknown };
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execa("git", args, { cwd });
}
