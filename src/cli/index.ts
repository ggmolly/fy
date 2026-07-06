#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { createApp } from "../server/app";
import { createRepoContext, GitUserError, type InitialSource } from "../git/git";
import { createAgentCommand } from "./agent";

interface CliOptions {
  base?: string;
  pr?: string;
  repo: string;
  staged?: boolean;
  working?: boolean;
  patch?: string;
  open?: boolean;
  foreground?: boolean;
  port?: number;
}

const program = new Command()
  .name("fy")
  .description("fy - local diff review powered by Pierre Computer Diffs")
  .option("--base <ref>", "review git diff <ref>...HEAD")
  .option("--pr <number-or-url>", "review a GitHub PR using gh")
  .option("--repo <path>", "repo to inspect", process.cwd())
  .option("--staged", "review staged changes")
  .option("--working", "review unstaged working tree changes")
  .option("--patch <path>", "review an existing patch file")
  .option("--no-open", "do not open a browser")
  .option("--foreground", "keep the server in the foreground", true)
  .option("--port <number>", "preferred local port", parsePort)
  .action(async (options: CliOptions) => {
    try {
      const initialSource = await getInitialSource(options);
      const repo = await createRepoContext(options.repo, initialSource);
      const app = createApp(repo);
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: options.port ?? 0,
        fetch: app.fetch,
      });
      const url = `http://127.0.0.1:${server.port}`;
      console.log(`fy: ${url}`);
      console.log(`repo: ${repo.repoRoot}`);

      if (options.open !== false) {
        openBrowser(url);
      }

      const stop = () => {
        server.stop(true);
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => undefined);
    } catch (error) {
      if (error instanceof GitUserError || error instanceof InvalidArgumentError) {
        console.error(error.message);
        process.exit(1);
      }
      console.error(error);
      process.exit(1);
    }
  });

program.addCommand(createAgentCommand());

program.parseAsync().catch((error) => {
  if (error instanceof GitUserError || error instanceof InvalidArgumentError) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});

async function getInitialSource(options: CliOptions): Promise<InitialSource> {
  const selected = [options.pr, options.patch, options.staged, options.working, options.base].filter(Boolean);
  if (selected.length > 1) {
    throw new InvalidArgumentError("choose only one initial source: --pr, --patch, --staged, --working, or --base");
  }
  if (options.pr) return { mode: "pr", pr: parsePr(options.pr) };
  if (options.patch) return { mode: "patch", patchPath: await validatePatchPath(options.patch) };
  if (options.staged) return { mode: "staged" };
  if (options.base) return { mode: "base", base: options.base };
  return { mode: "working" };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("port must be an integer between 1 and 65535");
  }
  return port;
}

function parsePr(value: string): number {
  const match = /(?:\/pull\/)?(\d+)$/.exec(value);
  if (!match) throw new InvalidArgumentError("invalid PR number or URL");
  return Number(match[1]);
}

async function validatePatchPath(path: string): Promise<string> {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new InvalidArgumentError(`invalid patch path: ${path}`);
  }
  return realpath(resolved);
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  Bun.spawn([command, ...args], { stdout: "ignore", stderr: "ignore" });
}
