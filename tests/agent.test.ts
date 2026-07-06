import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { execa } from "execa";
import { createRepoContext } from "../src/git/git";
import { saveReviewStore } from "../src/review/state";

describe("agent CLI", () => {
  test("prints next open finding and a Codex prompt", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "fy-agent-"));
    const cachePath = await mkdtemp(join(tmpdir(), "fy-agent-cache-"));
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test User"]);
    await writeFile(join(repoPath, "README.md"), "hello\n");
    await git(repoPath, ["add", "README.md"]);
    await git(repoPath, ["commit", "-m", "initial"]);

    process.env.XDG_CACHE_HOME = cachePath;
    const repo = await createRepoContext(repoPath, { mode: "working" });
    await saveReviewStore(repo.repoRoot, {
      version: 1,
      viewedFileHashes: [],
      autoViewRules: [],
      comparisons: {
        working: {
          comparisonKey: "working",
          viewedFiles: [],
          collapsedFiles: [],
          expandedFiles: [],
          layout: "split",
          updatedAt: "2026-01-01T00:00:00.000Z",
          findings: [
            {
              id: "finding-1",
              comparisonKey: "working",
              filePath: "README.md",
              newLine: 1,
              author: "molly",
              comment: "Should this be changed?",
              status: "open",
              replies: [],
              selectedCode: "hello",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "finding-2",
              comparisonKey: "working",
              filePath: "README.md",
              newLine: 1,
              author: "molly",
              comment: "Please fix this greeting.",
              status: "open",
              replies: [],
              createdAt: "2026-01-01T00:00:01.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
          ],
        },
      },
    });

    const next = await runFyAgent(repoPath, cachePath, ["agent", "next", "--repo", repoPath]);
    expect(next.stdout).toContain("[open] finding-1 working README.md:1");
    expect(next.stdout).toContain("Should this be changed?");

    const prompt = await runFyAgent(repoPath, cachePath, ["agent", "prompt", "--repo", repoPath]);
    expect(prompt.stdout).toContain("Please address these fy review comments");
    expect(prompt.stdout).toContain("fy-review");
    expect(prompt.stdout).toContain("[finding-1] README.md:1");
    expect(prompt.stdout).toContain("fy agent reply <comment-id>");

    const questionPrompt = await runFyAgent(repoPath, cachePath, ["agent", "prompt", "--repo", repoPath, "--mode", "questions"]);
    expect(questionPrompt.stdout).toContain("Please answer these fy review questions");
    expect(questionPrompt.stdout).toContain("[finding-1] README.md:1");
    expect(questionPrompt.stdout).not.toContain("[finding-2] README.md:1");
  });
});

async function runFyAgent(repoPath: string, cachePath: string, args: string[]): Promise<{ stdout: string }> {
  const result = await execa("bun", ["src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, XDG_CACHE_HOME: cachePath },
  });
  return { stdout: String(result.stdout) };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execa("git", args, { cwd });
}
