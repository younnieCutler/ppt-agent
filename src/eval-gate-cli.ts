import path from "node:path";
import { writeEvalGateReport } from "./eval-gate";

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

export function runEvalGateCommand(args: string[]): { exitCode: number; report: ReturnType<typeof writeEvalGateReport> } {
  const report = writeEvalGateReport({
    runDir: path.resolve(option(args, "--run-dir")),
    benchmark: option(args, "--benchmark"),
    projectDir: path.resolve(optionalOption(args, "--project-dir") ?? projectDirectory()),
  });
  return { exitCode: report.status === "fail" ? 2 : 0, report };
}

if (require.main === module) {
  try {
    const { exitCode, report } = runEvalGateCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
