import { createHash } from "node:crypto";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { DiffFileSummary, FileStatus } from "../shared/types";
import { checkGeneratedFile } from "./generated";

export function parseDiff(raw: string, cacheKeyPrefix: string): FileDiffMetadata[] {
  if (raw.trim() === "") {
    return [];
  }

  try {
    return parsePatchFiles(raw, cacheKeyPrefix).flatMap((patch) => patch.files);
  } catch {
    return [];
  }
}

export function summarizeParsedFiles(files: FileDiffMetadata[]): DiffFileSummary[] {
  return files.map((file) => {
    const generated = checkGeneratedFile(file.name, file.additionLines);
    return {
      path: file.name,
      previousPath: file.prevName,
      status: mapPierreStatus(file.type),
      additions: file.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
      deletions: file.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
      contentHash: hashFileDiff(file),
      isGenerated: generated.isGenerated,
      generatedReason: generated.reason,
    };
  });
}

export function summarizeDiff(raw: string, parsedFiles: FileDiffMetadata[]): DiffFileSummary[] {
  const parsed = summarizeParsedFiles(parsedFiles);
  if (parsed.length > 0 || raw.trim() === "") {
    return parsed;
  }

  return summarizeUnifiedDiff(raw);
}

function mapPierreStatus(type: FileDiffMetadata["type"]): FileStatus {
  if (type === "new") return "added";
  if (type === "deleted") return "deleted";
  if (type === "rename-pure" || type === "rename-changed") return "renamed";
  return "modified";
}

function summarizeUnifiedDiff(raw: string): DiffFileSummary[] {
  const files: DiffFileSummary[] = [];
  let current: DiffFileSummary | undefined;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = {
        path: match?.[2] ?? line.slice("diff --git ".length),
        previousPath: match?.[1],
        status: "modified",
        additions: 0,
        deletions: 0,
        contentHash: "",
        isGenerated: false,
      };
      continue;
    }

    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    if (line.startsWith("deleted file mode")) current.status = "deleted";
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.previousPath = line.slice("rename from ".length);
    }
    if (line.startsWith("rename to ")) current.path = line.slice("rename to ".length);
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
  }

  if (current) files.push(current);
  return files.map((file) => {
    const generated = checkGeneratedFile(file.path);
    return { ...file, contentHash: hashSummary(file), isGenerated: generated.isGenerated, generatedReason: generated.reason };
  });
}

function hashFileDiff(file: FileDiffMetadata): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        path: file.name,
        previousPath: file.prevName,
        type: file.type,
        hunks: file.hunks.map((hunk) => hunk.hunkSpecs),
        additions: file.additionLines,
        deletions: file.deletionLines,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

function hashSummary(file: DiffFileSummary): string {
  return createHash("sha256")
    .update(`${file.path}\0${file.previousPath ?? ""}\0${file.status}\0${file.additions}\0${file.deletions}`)
    .digest("hex")
    .slice(0, 24);
}
