import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { contractSchema, type GenerationContract } from "./schema";
import { sha256File } from "./provenance";
import { createRunWorkspace } from "./workspace";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const benchmarkIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const benchmarkTaskSchema = z.object({
  id: benchmarkIdSchema,
  name: z.string().min(1),
  domain: z.string().min(1),
  referenceMode: z.string().min(1),
  prompt: z.string().min(1),
  contract: z.record(z.string(), z.unknown()),
  sources: z.array(z.string().min(1)).min(1),
  baseline: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const benchmarkRunBindingSchema = z.object({
  version: z.literal(1),
  benchmark: benchmarkIdSchema,
  taskDigest: digestSchema,
  policyDigest: digestSchema.optional(),
  contractDigest: digestSchema,
  sources: z.array(z.object({
    id: z.string().min(1),
    path: z.string().min(1),
    sha256: digestSchema,
  }).strict()).min(1),
  startedAt: z.string().datetime(),
}).strict();

export type BenchmarkRunBinding = z.infer<typeof benchmarkRunBindingSchema>;
export type BenchmarkBindingCheck = { status: "pass" | "fail"; errors: string[]; binding?: BenchmarkRunBinding };

function benchmarkDirectory(projectDir: string, benchmark: string): string {
  benchmarkIdSchema.parse(benchmark);
  return path.join(path.resolve(projectDir), "evals", "real-world", benchmark);
}

function taskPath(projectDir: string, benchmark: string): string {
  return path.join(benchmarkDirectory(projectDir, benchmark), "task.yaml");
}

function policyPath(projectDir: string, benchmark: string): string {
  return path.join(benchmarkDirectory(projectDir, benchmark), "policy.yaml");
}

function normalizeRelative(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function resolveBenchmarkSource(benchmarkDir: string, sourcePath: string): string {
  if (path.isAbsolute(sourcePath)) throw new Error(`Benchmark source paths must be relative: ${sourcePath}`);
  const resolved = path.resolve(benchmarkDir, sourcePath);
  const root = `${path.resolve(benchmarkDir)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error(`Benchmark source escapes its fixture directory: ${sourcePath}`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Benchmark source does not exist: ${resolved}`);
  return resolved;
}

function sourceType(filePath: string): "md" | "txt" | "pdf" | "image" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md") return "md";
  if (ext === ".txt") return "txt";
  if (ext === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return "image";
  throw new Error(`Unsupported benchmark source extension '${ext}' for ${filePath}.`);
}

export function loadBenchmarkTask(projectDir: string, benchmark: string): z.infer<typeof benchmarkTaskSchema> {
  const filePath = taskPath(projectDir, benchmark);
  if (!fs.existsSync(filePath)) throw new Error(`Benchmark task does not exist: ${filePath}`);
  const task = benchmarkTaskSchema.parse(parseYaml(fs.readFileSync(filePath, "utf8")));
  if (task.id !== benchmark) throw new Error(`Benchmark id mismatch: requested '${benchmark}' but task.yaml declares '${task.id}'.`);
  return task;
}

function buildBenchmarkContract(projectDir: string, benchmark: string, task: z.infer<typeof benchmarkTaskSchema>): { contract: GenerationContract; sources: BenchmarkRunBinding["sources"] } {
  const fixtureDir = benchmarkDirectory(projectDir, benchmark);
  const sources = task.sources.map((declaredPath, index) => {
    const absolute = resolveBenchmarkSource(fixtureDir, declaredPath);
    const id = `benchmark-source-${String(index + 1).padStart(2, "0")}`;
    return {
      id,
      absolute,
      contractPath: normalizeRelative(path.relative(path.resolve(projectDir), absolute)),
      sha256: sha256File(absolute),
    };
  });
  const contract = contractSchema.parse({
    ...task.contract,
    sources: sources.map((source) => ({ kind: "file", id: source.id, path: source.contractPath, type: sourceType(source.absolute) })),
    brand: (task.contract as { brand?: unknown }).brand ?? { kind: "default" },
  });
  return {
    contract,
    sources: sources.map(({ id, contractPath: sourcePath, sha256 }) => ({ id, path: sourcePath, sha256 })),
  };
}

export function startBenchmarkRun(projectDirInput: string, benchmark: string): {
  status: "pass";
  benchmark: string;
  runId: string;
  runDir: string;
  contractPath: string;
  contextPath: string;
  bindingPath: string;
} {
  const projectDir = path.resolve(projectDirInput);
  const task = loadBenchmarkTask(projectDir, benchmark);
  const { contract, sources } = buildBenchmarkContract(projectDir, benchmark, task);
  const workspace = createRunWorkspace(projectDir, `benchmark-${benchmark}`);
  const contractPath = path.join(workspace.runDir, "contract.json");
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2));

  const benchmarkTaskPath = taskPath(projectDir, benchmark);
  const benchmarkPolicyPath = policyPath(projectDir, benchmark);
  const binding: BenchmarkRunBinding = benchmarkRunBindingSchema.parse({
    version: 1,
    benchmark,
    taskDigest: sha256File(benchmarkTaskPath),
    policyDigest: fs.existsSync(benchmarkPolicyPath) ? sha256File(benchmarkPolicyPath) : undefined,
    contractDigest: sha256File(contractPath),
    sources,
    startedAt: new Date().toISOString(),
  });
  const bindingPath = path.join(workspace.runDir, "benchmark-run.json");
  fs.writeFileSync(bindingPath, JSON.stringify(binding, null, 2));

  const contextPath = path.join(workspace.runDir, "benchmark-context.json");
  fs.writeFileSync(contextPath, JSON.stringify({
    version: 1,
    kind: "real_world_benchmark",
    benchmark,
    name: task.name,
    domain: task.domain,
    referenceMode: task.referenceMode,
    prompt: task.prompt,
    contractPath,
    sources: binding.sources.map((source) => ({ id: source.id, path: source.path })),
    canonicalWorkflow: "SKILL.md",
    rule: "Run the canonical /ppt workflow. Do not read baseline/ or history.jsonl while authoring or judging this run; those are regression outputs, not generation inputs.",
  }, null, 2));

  return { status: "pass", benchmark, ...workspace, contractPath, contextPath, bindingPath };
}

export function verifyBenchmarkRunBinding(projectDirInput: string, runDirInput: string, benchmark: string): BenchmarkBindingCheck {
  const projectDir = path.resolve(projectDirInput);
  const runDir = path.resolve(runDirInput);
  const bindingPath = path.join(runDir, "benchmark-run.json");
  if (!fs.existsSync(bindingPath)) return { status: "fail", errors: [`Missing benchmark binding: ${bindingPath}. Start the run with \`npm run benchmark -- start\`.`] };

  let binding: BenchmarkRunBinding;
  try {
    binding = benchmarkRunBindingSchema.parse(JSON.parse(fs.readFileSync(bindingPath, "utf8")));
  } catch (error) {
    return { status: "fail", errors: [`benchmark-run.json failed schema validation: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const errors: string[] = [];
  if (binding.benchmark !== benchmark) errors.push(`Binding is for '${binding.benchmark}', not '${benchmark}'.`);

  const currentTaskPath = taskPath(projectDir, benchmark);
  if (!fs.existsSync(currentTaskPath)) errors.push(`Current benchmark task is missing: ${currentTaskPath}.`);
  else if (sha256File(currentTaskPath) !== binding.taskDigest) errors.push("task.yaml changed after this benchmark run started.");

  const currentPolicyPath = policyPath(projectDir, benchmark);
  const currentPolicyDigest = fs.existsSync(currentPolicyPath) ? sha256File(currentPolicyPath) : undefined;
  if (currentPolicyDigest !== binding.policyDigest) errors.push("policy.yaml changed after this benchmark run started.");

  const contractPath = path.join(runDir, "contract.json");
  if (!fs.existsSync(contractPath)) errors.push(`Run contract is missing: ${contractPath}.`);
  else if (sha256File(contractPath) !== binding.contractDigest) errors.push("contract.json changed after this benchmark run started.");

  for (const source of binding.sources) {
    const absolute = path.resolve(projectDir, source.path);
    const projectRoot = `${projectDir}${path.sep}`;
    if (!absolute.startsWith(projectRoot)) {
      errors.push(`Bound source escapes project directory: ${source.path}.`);
      continue;
    }
    if (!fs.existsSync(absolute)) errors.push(`Bound source is missing: ${source.path}.`);
    else if (sha256File(absolute) !== source.sha256) errors.push(`Bound source changed after run start: ${source.path}.`);
  }

  return { status: errors.length === 0 ? "pass" : "fail", errors, binding };
}
