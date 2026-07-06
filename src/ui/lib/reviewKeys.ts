import type { ReviewFinding } from "../../shared/types";

export function viewedHashKey(path: string, contentHash: string): string {
  return `${path}\0${contentHash}`;
}

export function hashItemVersion(file: string, collapsed: boolean, hasDraft: boolean, findings: ReviewFinding[]): number {
  let hash = collapsed ? 17 : 31;
  hash = hash * 31 + (hasDraft ? 1 : 0);
  for (const value of [file, ...findings.map((finding) => `${finding.id}:${finding.updatedAt}:${finding.status}:${finding.comment}:${finding.replies.length}`)]) {
    for (let index = 0; index < value.length; index += 1) {
      hash = (hash * 33 + value.charCodeAt(index)) >>> 0;
    }
  }
  return hash;
}
