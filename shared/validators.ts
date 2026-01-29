import { z } from "zod";

export const WorkflowStepSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "goto",
    "click",
    "type",
    "press",
    "wait_for_selector",
    "wait_time",
    "screenshot",
    "evaluate",
    "set_var",
    "conditional",
  ]),
  selector: z.string().optional(),
  value: z.string().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  retries: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});

export const WorkflowDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  steps: z.array(WorkflowStepSchema),
  updatedAt: z.string().min(1),
});

export const RunSettingsSchema = z.object({
  headless: z.boolean(),
  slowMoMs: z.number().int().nonnegative(),
  timeoutMs: z.number().int().nonnegative(),
  delayMinMs: z.number().int().nonnegative(),
  delayMaxMs: z.number().int().nonnegative(),
  concurrency: z.number().int().positive(),
  bestEffort: z.boolean(),
  dryRun: z.boolean().default(false),
  stepThrough: z.boolean().default(false),
  storageState: z.string().optional(),
});

export const CsvRowSchema = z.record(z.string());

export const JobSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workflowId: z.string().min(1),
  csvFileName: z.string().min(1),
  headers: z.array(z.string()),
  rows: z.array(CsvRowSchema),
  createdAt: z.string().min(1),
});

export const RunSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  status: z.enum(["idle", "running", "paused", "stopped", "error", "complete"]),
  currentRowIndex: z.number().int(),
  currentStepIndex: z.number().int().nonnegative().default(0),
  lastCompletedRow: z.number().int(),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  settings: RunSettingsSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const RunLogSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  rowIndex: z.number().int(),
  stepIndex: z.number().int(),
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  timestamp: z.string(),
});

export const RowResultSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  rowIndex: z.number().int(),
  status: z.enum(["success", "failed", "skipped"]),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative().optional(),
  artifacts: z
    .object({
      screenshot: z.string().optional(),
      htmlSnapshot: z.string().optional(),
      consoleLogs: z.array(z.string()).optional(),
    })
    .default({}),
});

export const ACPExportSchema = z.object({
  version: z.number().int().positive(),
  exportedAt: z.string().min(1),
  workflows: z.array(WorkflowDefinitionSchema),
  jobs: z.array(JobSchema),
  runs: z.array(RunSchema),
  logs: z.array(RunLogSchema),
  rowResults: z.array(RowResultSchema),
});
