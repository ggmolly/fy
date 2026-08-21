import type { PreviewRefs } from "../types";

export function isPreviewableFile(path: string): boolean {
  return getPreviewKind(path) !== null;
}

export function getPreviewKind(path: string): "image" | "markdown" | "notebook" | null {
  const lowered = path.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/.test(lowered)) return "image";
  if (/\.(md|markdown)$/.test(lowered)) return "markdown";
  if (lowered.endsWith(".ipynb")) return "notebook";
  return null;
}

export function resolvePreviewRefs(comparisonKey: string): PreviewRefs {
  if (comparisonKey === "working" || comparisonKey === "working-no-untracked" || comparisonKey === "staged") {
    return { baseRef: "HEAD", targetRef: "working" };
  }
  if (comparisonKey.endsWith("...working") || comparisonKey.endsWith("...working-no-untracked")) {
    const suffix = comparisonKey.endsWith("...working-no-untracked") ? "...working-no-untracked" : "...working";
    return { baseRef: comparisonKey.slice(0, -suffix.length), targetRef: "working" };
  }
  if (comparisonKey.startsWith("commit-")) {
    const sha = comparisonKey.slice("commit-".length);
    return { baseRef: `${sha}^`, targetRef: sha };
  }
  if (comparisonKey.includes("...")) {
    const [baseRef, targetRef] = comparisonKey.split("...");
    return { baseRef, targetRef };
  }
  return { targetRef: "working" };
}

export function blobUrl(path: string, ref: string): string {
  const params = new URLSearchParams({ path, ref });
  return `/api/blob?${params.toString()}`;
}
