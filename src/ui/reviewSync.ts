import type { ComparisonReviewState, ReviewFinding } from "../shared/types";

export function mergeRemoteReview(
  current: ComparisonReviewState,
  remote: ComparisonReviewState,
  editingFindingIds: ReadonlySet<string> = new Set(),
): ComparisonReviewState {
  if (current.comparisonKey !== remote.comparisonKey) return current;

  const currentFindings = new Map(current.findings.map((finding) => [finding.id, finding]));
  const remoteFindings = new Map(remote.findings.map((finding) => [finding.id, finding]));
  const findings: ReviewFinding[] = remote.findings.map((remoteFinding) => {
    const currentFinding = currentFindings.get(remoteFinding.id);
    if (!currentFinding) return remoteFinding;
    if (editingFindingIds.has(remoteFinding.id)) {
      return { ...remoteFinding, comment: currentFinding.comment };
    }
    return isAfter(currentFinding.updatedAt, remoteFinding.updatedAt) ? currentFinding : remoteFinding;
  });

  for (const currentFinding of current.findings) {
    if (remoteFindings.has(currentFinding.id)) continue;
    if (editingFindingIds.has(currentFinding.id) || isAfter(currentFinding.updatedAt, remote.updatedAt)) {
      findings.push(currentFinding);
    }
  }

  return { ...remote, findings };
}

export function sameReview(a: ComparisonReviewState, b: ComparisonReviewState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isAfter(left: string, right: string): boolean {
  return new Date(left).getTime() > new Date(right).getTime();
}
