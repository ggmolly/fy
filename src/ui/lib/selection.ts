import type { DiffResponse } from "../../shared/types";
import type { CodeViewLineSelection } from "../types";

export function formatSelectionLabel(selection: CodeViewLineSelection): string {
  const prefix = selection.range.side === "deletions" || selection.range.endSide === "deletions" ? "L" : "R";
  if (selection.range.start === selection.range.end) return `${prefix}${selection.range.end}`;
  return `${prefix}${selection.range.start} to ${prefix}${selection.range.end}`;
}

export function getSelectedCode(file: DiffResponse["parsedFiles"][number] | undefined, selection: CodeViewLineSelection): string | undefined {
  if (!file) return undefined;
  const side = selection.range.endSide ?? selection.range.side;
  const source = side === "deletions" ? file.deletionLines : file.additionLines;
  const start = Math.min(selection.range.start, selection.range.end);
  const end = Math.max(selection.range.start, selection.range.end);
  return source.slice(Math.max(0, start - 1), end).join("\n");
}

export function getContext(file: DiffResponse["parsedFiles"][number] | undefined, selection: CodeViewLineSelection): string[] {
  if (!file) return [];
  const side = selection.range.endSide ?? selection.range.side;
  const line = selection.range.end;
  const source = side === "deletions" ? file.deletionLines : file.additionLines;
  return source.slice(Math.max(0, line - 3), line + 2);
}
