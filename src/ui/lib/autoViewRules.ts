export function parseAutoViewRules(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => normalizePath(line.trim())).filter(Boolean))];
}

export function matchesAutoViewRules(path: string, rules: string[]): boolean {
  return rules.some((rule) => matchesAutoViewRule(path, rule));
}

function matchesAutoViewRule(path: string, rule: string): boolean {
  const normalizedRule = normalizePath(rule);
  const normalizedPath = normalizePath(path);
  if (!normalizedRule.includes("/")) {
    return matchesPathSegment(normalizedPath.split("/").pop() ?? normalizedPath, normalizedRule);
  }
  return matchesPathSegments(normalizedPath.split("/").filter(Boolean), normalizedRule.split("/").filter(Boolean));
}

function matchesPathSegments(pathSegments: string[], ruleSegments: string[], pathIndex = 0, ruleIndex = 0): boolean {
  const rule = ruleSegments[ruleIndex];
  if (!rule) return pathIndex >= pathSegments.length;
  if (rule === "**") {
    if (ruleIndex + 1 >= ruleSegments.length) return true;
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (matchesPathSegments(pathSegments, ruleSegments, nextPathIndex, ruleIndex + 1)) return true;
    }
    return false;
  }
  const segment = pathSegments[pathIndex];
  return Boolean(segment && matchesPathSegment(segment, rule) && matchesPathSegments(pathSegments, ruleSegments, pathIndex + 1, ruleIndex + 1));
}

function matchesPathSegment(value: string, rule: string): boolean {
  const regex = new RegExp(`^${rule.replace(/[|\\{}()[\]^$+.]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".")}$`);
  return regex.test(value);
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\/+/, "");
}
