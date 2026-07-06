import type { SelectedLineRange } from "@pierre/diffs/react";
import type { ComparisonReviewState, ReviewFinding } from "../../shared/types";
import type { PromptMode } from "../types";

export function splitSuggestionBlocks(body: string): Array<{ kind: "text"; text: string } | { kind: "suggestion"; code: string }> {
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

export function renderCodexPrompt(review: ComparisonReviewState, mode: PromptMode): string {
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

export function isQuestionFinding(finding: Pick<ReviewFinding, "comment" | "replies">): boolean {
  return [finding.comment, ...finding.replies.map((reply) => reply.body)].some((text) => text.trim().endsWith("?"));
}

export function formatFindingForMarkdown(finding: ReviewFinding): string[] {
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

export function lineLabel(finding: { oldLine?: number; newLine?: number; range?: SelectedLineRange }): string {
  if (finding.range) {
    const start = Math.min(finding.range.start, finding.range.end);
    const end = Math.max(finding.range.start, finding.range.end);
    return start === end ? `:${end}` : `:${start}-${end}`;
  }
  if (finding.newLine != null) return `:${finding.newLine}`;
  if (finding.oldLine != null) return `:${finding.oldLine}`;
  return "";
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

function formatCommentForPrompt(comment: string): string {
  return splitSuggestionBlocks(comment)
    .map((part) => (part.kind === "text" ? part.text : `Suggested replacement:\n\`\`\`\n${part.code}\n\`\`\``))
    .filter(Boolean)
    .join("\n\n");
}

function indentBlock(value: string, prefix: string): string[] {
  return value.split("\n").map((line) => `${prefix}${line}`);
}
