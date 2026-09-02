import path from "node:path";
import {
  effectiveFeedbackConclusion,
  loadFeedbackCase,
  promoteFeedbackCase,
  recordFailure,
  recordResolution,
  recordSystemDiagnosis,
  recordUserCorrection,
} from "./feedback";

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing required option ${name}`);
  return args[index + 1];
}

function optionalOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function evidence(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--evidence" && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("Usage: feedback-cli <failure|diagnose|correct|resolve|show|promote> ...");

  if (command === "failure") {
    const result = recordFailure({
      runDir: option(args, "--run-dir"),
      runId: optionalOption(args, "--run-id"),
      stage: option(args, "--stage"),
      code: option(args, "--code"),
      message: option(args, "--message"),
      caseId: optionalOption(args, "--case-id"),
      evidence: evidence(args),
    });
    print({ status: "recorded", reportPath: result.reportPath, casePath: result.casePath, caseId: result.feedbackCase.caseId });
    return;
  }

  const casePath = path.resolve(option(args, "--case"));

  if (command === "diagnose") {
    const value = recordSystemDiagnosis(casePath, {
      summary: option(args, "--summary"),
      code: optionalOption(args, "--code"),
      evidence: evidence(args),
    });
    print({ status: "recorded", casePath, effectiveConclusion: effectiveFeedbackConclusion(value) });
    return;
  }

  if (command === "correct") {
    const value = recordUserCorrection(casePath, {
      summary: option(args, "--summary"),
      code: optionalOption(args, "--code"),
      evidence: evidence(args),
    });
    print({ status: "accepted", casePath, effectiveConclusion: effectiveFeedbackConclusion(value) });
    return;
  }

  if (command === "resolve") {
    const value = recordResolution(casePath, {
      summary: option(args, "--summary"),
      code: optionalOption(args, "--code"),
      evidence: evidence(args),
    });
    print({ status: "resolved", casePath, effectiveConclusion: effectiveFeedbackConclusion(value) });
    return;
  }

  if (command === "show") {
    const value = loadFeedbackCase(casePath);
    print({ feedbackCase: value, effectiveConclusion: effectiveFeedbackConclusion(value) });
    return;
  }

  if (command === "promote") {
    const result = promoteFeedbackCase(casePath, {
      projectDir: option(args, "--project-dir"),
      expectedBehavior: option(args, "--expected"),
      testPath: option(args, "--test"),
      fixturePath: optionalOption(args, "--fixture"),
    });
    print({ status: "promoted", promotedPath: result.promotedPath, effectiveConclusion: effectiveFeedbackConclusion(result.feedbackCase) });
    return;
  }

  throw new Error(`Unknown feedback command: ${command}`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
