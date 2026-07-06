import { InvalidArgumentError, Command } from "commander";
import { createRepoContext } from "../git/git";
import { loadReviewStore, saveReviewStore } from "../review/state";
import type { ComparisonReviewState, ReviewFinding, ReviewStore } from "../shared/types";

interface AgentOptions {
  repo?: string;
  json?: boolean;
  body?: string;
  author?: string;
  status?: "open" | "resolved" | "all";
  mode?: "all" | "fixes" | "questions";
}

interface FindingMatch {
  comparison: ComparisonReviewState;
  finding: ReviewFinding;
}

const defaultAuthor = "codex";

export function createAgentCommand(): Command {
  const agent = new Command("agent")
    .description("Inspect and update cached fy review comments")
    .option("--repo <path>", "repo to inspect", process.cwd());

  agent
    .command("list")
    .description("list cached review comments")
    .option("--repo <path>", "repo to inspect")
    .option("--status <status>", "open, resolved, or all", parseStatus, "all")
    .option("--json", "print machine-readable JSON")
    .action(withAgentErrors(async (options: AgentOptions, command: Command) => {
      const { repoRoot, store } = await loadStore(repoPath(options, command));
      const findings = filterFindings(flattenFindings(store), options.status ?? "all");
      if (options.json) {
        console.log(JSON.stringify({ repoRoot, findings }, null, 2));
        return;
      }
      if (findings.length === 0) {
        console.log("No fy review comments found.");
        return;
      }
      for (const item of findings) {
        printFinding(item);
      }
    }));

  agent
    .command("next")
    .description("print the next open cached review comment")
    .option("--repo <path>", "repo to inspect")
    .option("--json", "print machine-readable JSON")
    .action(withAgentErrors(async (options: AgentOptions, command: Command) => {
      const { repoRoot, store } = await loadStore(repoPath(options, command));
      const item = filterFindings(flattenFindings(store), "open")[0];
      if (!item) {
        console.log(options.json ? JSON.stringify({ repoRoot, finding: null }, null, 2) : "No open fy review comments.");
        return;
      }
      if (options.json) {
        console.log(JSON.stringify({ repoRoot, ...item }, null, 2));
        return;
      }
      printFinding(item);
    }));

  agent
    .command("prompt")
    .description("print a Codex prompt for open cached review comments")
    .option("--repo <path>", "repo to inspect")
    .option("--mode <mode>", "all, fixes, or questions", parsePromptMode, "all")
    .action(withAgentErrors(async (options: AgentOptions, command: Command) => {
      const { store } = await loadStore(repoPath(options, command));
      const findings = filterPromptFindings(filterFindings(flattenFindings(store), "open"), options.mode ?? "all");
      console.log(renderPrompt(findings, options.mode ?? "all"));
    }));

  agent
    .command("reply")
    .description("reply to a cached review comment")
    .argument("<finding-id>")
    .requiredOption("--body <text>", "reply body")
    .option("--author <name>", "reply author", defaultAuthor)
    .option("--repo <path>", "repo to inspect")
    .action(withAgentErrors(async (id: string, options: AgentOptions, command: Command) => {
      await updateFinding(repoPath(options, command), id, (finding) => addReply(finding, options.body, options.author));
      console.log(`Replied to ${id}.`);
    }));

  agent
    .command("resolve")
    .description("mark a cached review comment as resolved")
    .argument("<finding-id>")
    .option("--body <text>", "optional resolution note")
    .option("--author <name>", "reply author", defaultAuthor)
    .option("--repo <path>", "repo to inspect")
    .action(withAgentErrors(async (id: string, options: AgentOptions, command: Command) => {
      await updateFinding(repoPath(options, command), id, (finding) => {
        const next = options.body ? addReply(finding, options.body, options.author) : finding;
        return { ...next, status: "resolved", updatedAt: new Date().toISOString() };
      });
      console.log(`Resolved ${id}.`);
    }));

  agent
    .command("reopen")
    .description("mark a cached review comment as open")
    .argument("<finding-id>")
    .option("--repo <path>", "repo to inspect")
    .action(withAgentErrors(async (id: string, options: AgentOptions, command: Command) => {
      await updateFinding(repoPath(options, command), id, (finding) => ({ ...finding, status: "open", updatedAt: new Date().toISOString() }));
      console.log(`Reopened ${id}.`);
    }));

  agent
    .command("delete")
    .description("delete a cached review comment")
    .argument("<finding-id>")
    .option("--repo <path>", "repo to inspect")
    .action(withAgentErrors(async (id: string, options: AgentOptions, command: Command) => {
      const { repoRoot, store } = await loadStore(repoPath(options, command));
      const match = findFinding(store, id);
      if (!match) throw new InvalidArgumentError(`finding not found: ${id}`);
      match.comparison.findings = match.comparison.findings.filter((finding) => finding.id !== id);
      match.comparison.updatedAt = new Date().toISOString();
      await saveReviewStore(repoRoot, store);
      console.log(`Deleted ${id}.`);
    }));

  return agent;
}

function repoPath(options: AgentOptions, command: Command): string {
  return options.repo ?? command.optsWithGlobals<{ repo?: string }>().repo ?? (command.parent?.opts<{ repo?: string }>().repo) ?? process.cwd();
}

function parseStatus(value: string): "open" | "resolved" | "all" {
  if (value === "open" || value === "resolved" || value === "all") return value;
  throw new InvalidArgumentError("--status must be open, resolved, or all");
}

function parsePromptMode(value: string): "all" | "fixes" | "questions" {
  if (value === "all" || value === "fixes" || value === "questions") return value;
  throw new InvalidArgumentError("--mode must be all, fixes, or questions");
}

function withAgentErrors<T extends unknown[]>(action: (...args: T) => Promise<void>): (...args: T) => Promise<void> {
  return async (...args) => {
    try {
      await action(...args);
    } catch (error) {
      if (error instanceof InvalidArgumentError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
  };
}

async function loadStore(repoPath: string): Promise<{ repoRoot: string; store: ReviewStore }> {
  const repo = await createRepoContext(repoPath, { mode: "working" });
  return { repoRoot: repo.repoRoot, store: await loadReviewStore(repo.repoRoot) };
}

async function updateFinding(
  repoPath: string,
  id: string,
  update: (finding: ReviewFinding) => ReviewFinding,
): Promise<void> {
  const { repoRoot, store } = await loadStore(repoPath);
  const match = findFinding(store, id);
  if (!match) throw new InvalidArgumentError(`finding not found: ${id}`);
  match.comparison.findings = match.comparison.findings.map((finding) => (finding.id === id ? update(finding) : finding));
  match.comparison.updatedAt = new Date().toISOString();
  await saveReviewStore(repoRoot, store);
}

function addReply(finding: ReviewFinding, body: string | undefined, author: string | undefined): ReviewFinding {
  if (!body?.trim()) throw new InvalidArgumentError("--body cannot be empty");
  const now = new Date().toISOString();
  return {
    ...finding,
    replies: [
      ...finding.replies,
      {
        id: crypto.randomUUID(),
        author: author?.trim() || defaultAuthor,
        body: body.trim(),
        createdAt: now,
        updatedAt: now,
      },
    ],
    updatedAt: now,
  };
}

function findFinding(store: ReviewStore, id: string): FindingMatch | null {
  for (const comparison of Object.values(store.comparisons)) {
    const finding = comparison.findings.find((candidate) => candidate.id === id);
    if (finding) return { comparison, finding };
  }
  return null;
}

function flattenFindings(store: ReviewStore): Array<{ comparisonKey: string; finding: ReviewFinding }> {
  return Object.values(store.comparisons).flatMap((comparison) =>
    comparison.findings.map((finding) => ({ comparisonKey: comparison.comparisonKey, finding })),
  ).sort((a, b) =>
    a.comparisonKey.localeCompare(b.comparisonKey)
    || a.finding.filePath.localeCompare(b.finding.filePath)
    || lineSortValue(a.finding) - lineSortValue(b.finding)
    || a.finding.createdAt.localeCompare(b.finding.createdAt),
  );
}

function filterFindings(
  findings: Array<{ comparisonKey: string; finding: ReviewFinding }>,
  status: "open" | "resolved" | "all",
): Array<{ comparisonKey: string; finding: ReviewFinding }> {
  return status === "all" ? findings : findings.filter((item) => item.finding.status === status);
}

function filterPromptFindings(
  findings: Array<{ comparisonKey: string; finding: ReviewFinding }>,
  mode: "all" | "fixes" | "questions",
): Array<{ comparisonKey: string; finding: ReviewFinding }> {
  if (mode === "questions") return findings.filter((item) => isQuestionFinding(item.finding));
  if (mode === "fixes") return findings.filter((item) => !isQuestionFinding(item.finding));
  return findings;
}

function printFinding(item: { comparisonKey: string; finding: ReviewFinding }): void {
  console.log(`[${item.finding.status}] ${item.finding.id} ${item.comparisonKey} ${item.finding.filePath}${lineLabel(item.finding)}`);
  console.log(`  ${item.finding.author}: ${item.finding.comment || "(empty)"}`);
  if (item.finding.selectedCode) {
    console.log("  selected:");
    for (const line of item.finding.selectedCode.split("\n")) console.log(`    ${line}`);
  }
  for (const reply of item.finding.replies) {
    console.log(`  - ${reply.author}: ${reply.body || "(empty)"}`);
  }
}

function renderPrompt(findings: Array<{ comparisonKey: string; finding: ReviewFinding }>, mode: "all" | "fixes" | "questions"): string {
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
      "Use `fy agent reply <comment-id> --body \"...\"` for each answer.",
      "",
    );
  } else if (mode === "fixes") {
    lines.push(
      "Only change code for comments that clearly ask for a code change or identify a concrete bug.",
      "Questions are intentionally excluded from this prompt.",
      "Use `fy agent resolve <comment-id>` after fixing a concrete issue.",
      "",
    );
  } else {
    lines.push(
      "Important: if a review comment is phrased as a question, answer it directly and do not modify code for that item.",
      "Only change code for comments that clearly ask for a code change or identify a concrete bug.",
      "Use `fy agent reply <comment-id> --body \"...\"` to answer questions.",
      "Use `fy agent resolve <comment-id>` after fixing a concrete issue.",
      "",
    );
  }
  if (findings.length === 0) {
    lines.push("There are no open fy review comments matching this prompt mode.");
    return lines.join("\n");
  }
  for (const item of findings) {
    lines.push(`Comparison: ${item.comparisonKey}`);
    lines.push(`- [${item.finding.id}] ${item.finding.filePath}${lineLabel(item.finding)} (${item.finding.author}):`);
    if (item.finding.selectedCode) {
      lines.push("  Original selected code:");
      for (const line of item.finding.selectedCode.split("\n")) lines.push(`    ${line}`);
    }
    for (const line of item.finding.comment.split("\n")) lines.push(`  ${line}`);
    for (const reply of item.finding.replies) {
      lines.push(`  Reply from ${reply.author}:`);
      for (const line of reply.body.split("\n")) lines.push(`    ${line}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function isQuestionFinding(finding: Pick<ReviewFinding, "comment" | "replies">): boolean {
  return [finding.comment, ...finding.replies.map((reply) => reply.body)].some((text) => text.trim().endsWith("?"));
}

function lineSortValue(finding: Pick<ReviewFinding, "oldLine" | "newLine" | "range">): number {
  return finding.range?.start ?? finding.newLine ?? finding.oldLine ?? 0;
}

function lineLabel(finding: Pick<ReviewFinding, "oldLine" | "newLine" | "range">): string {
  if (finding.range) {
    const start = Math.min(finding.range.start, finding.range.end);
    const end = Math.max(finding.range.start, finding.range.end);
    return start === end ? `:${end}` : `:${start}-${end}`;
  }
  if (finding.newLine != null) return `:${finding.newLine}`;
  if (finding.oldLine != null) return `:${finding.oldLine}`;
  return "";
}
