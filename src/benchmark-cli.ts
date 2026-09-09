import path from "node:path";
import { startBenchmarkRun, verifyBenchmarkRunBinding } from "./benchmark";

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required option ${name}`);
  return args[index + 1];
}

function optionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function projectDirectory(): string {
  return process.env.PPT_AGENT_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function runBenchmarkCommand(command: string, args: string[]): { exitCode: number; result: unknown } {
  const projectDir = path.resolve(optionalOption(args, "--project-dir") ?? projectDirectory());
  const benchmark = option(args, "--benchmark");
  if (command === "start") {
    return { exitCode: 0, result: startBenchmarkRun(projectDir, benchmark) };
  }
  if (command === "verify") {
    const result = verifyBenchmarkRunBinding(projectDir, option(args, "--run-dir"), benchmark);
    return { exitCode: result.status === "pass" ? 0 : 2, result };
  }
  throw new Error("Usage: benchmark-cli.js <start|verify> --benchmark <id> [--project-dir <dir>] [--run-dir <dir>]");
}

if (require.main === module) {
  try {
    const [, , command, ...args] = process.argv;
    if (!command) throw new Error("Usage: benchmark-cli.js <start|verify> --benchmark <id> [--project-dir <dir>] [--run-dir <dir>]");
    const { exitCode, result } = runBenchmarkCommand(command, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
