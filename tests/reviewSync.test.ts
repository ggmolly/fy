import { describe, expect, test } from "bun:test";
import { mergeRemoteReview } from "../src/ui/reviewSync";
import type { ComparisonReviewState, ReviewFinding } from "../src/shared/types";

describe("review sync", () => {
  test("merges remote comment updates into the current review", () => {
    const current = review({
      status: "open",
      comment: "please check",
      replies: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const remote = review({
      status: "resolved",
      comment: "please check",
      replies: [
        {
          id: "reply-1",
          author: "codex",
          body: "fixed",
          createdAt: "2026-01-01T00:01:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    expect(mergeRemoteReview(current, remote).findings[0]).toEqual(remote.findings[0]);
  });

  test("keeps the local comment while that finding is being edited", () => {
    const current = review({
      status: "open",
      comment: "local draft",
      replies: [],
      updatedAt: "2026-01-01T00:02:00.000Z",
    });
    const remote = review({
      status: "resolved",
      comment: "remote saved comment",
      replies: [],
      updatedAt: "2026-01-01T00:01:00.000Z",
    });

    const merged = mergeRemoteReview(current, remote, new Set(["finding-1"]));

    expect(merged.findings[0]).toEqual(expect.objectContaining({
      status: "resolved",
      comment: "local draft",
    }));
  });
});

function review(finding: Partial<ReviewFinding>): ComparisonReviewState {
  const updatedAt = finding.updatedAt ?? "2026-01-01T00:00:00.000Z";
  return {
    comparisonKey: "working",
    viewedFiles: [],
    collapsedFiles: [],
    expandedFiles: [],
    layout: "split",
    updatedAt,
    findings: [
      {
        id: "finding-1",
        comparisonKey: "working",
        filePath: "README.md",
        newLine: 1,
        author: "molly",
        comment: "please check",
        status: "open",
        replies: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt,
        ...finding,
      },
    ],
  };
}
