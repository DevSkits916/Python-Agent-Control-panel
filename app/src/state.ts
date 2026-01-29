import { uuidv4 } from "./utils";
import type { CsvRow, WorkflowDefinition, WorkflowStep, RunSettings } from "@shared/schema";

export type Job = {
  id: string;
  name: string;
  workflowId: string;
  csvFileName: string;
  headers: string[];
  rows: CsvRow[];
  createdAt: string;
};

export type RunStatus = "idle" | "running" | "paused" | "stopped" | "error" | "complete";

export type RunLog = {
  id: string;
  runId: string;
  rowIndex: number;
  stepIndex: number;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
};

export type RowResult = {
  runId: string;
  rowIndex: number;
  status: "success" | "failed" | "skipped";
  error: string | null;
  durationMs?: number;
  artifacts?: {
    screenshot?: string;
    htmlSnapshot?: string;
    consoleLogs?: string[];
  };
};

export type Run = {
  id: string;
  jobId: string;
  status: RunStatus;
  currentRowIndex: number;
  currentStepIndex: number;
  lastCompletedRow: number;
  successCount: number;
  failureCount: number;
  logs: RunLog[];
  rowResults: RowResult[];
  settings: RunSettings;
  createdAt: string;
  updatedAt: string;
};

export type ACPState = {
  workflows: WorkflowDefinition[];
  jobs: Job[];
  runs: Run[];
  debugEnabled: boolean;
  killSwitchEnabled: boolean;
};

export const createDefaultWorkflow = (): WorkflowDefinition => ({
  id: uuidv4(),
  name: "CSV URL + Post",
  updatedAt: new Date().toISOString(),
  steps: [
    {
      id: uuidv4(),
      type: "goto",
      value: "{{url}}",
      notes: "Navigate to the URL from the CSV row.",
      retries: 2,
      timeoutMs: 15000,
    },
    {
      id: uuidv4(),
      type: "wait_for_selector",
      selector: "body",
      retries: 2,
      timeoutMs: 15000,
    },
    {
      id: uuidv4(),
      type: "screenshot",
      value: "page",
      notes: "Capture evidence after load.",
    },
  ],
});

export const createDefaultSettings = (): RunSettings => ({
  headless: false,
  slowMoMs: 0,
  timeoutMs: 15000,
  delayMinMs: 300,
  delayMaxMs: 900,
  concurrency: 1,
  bestEffort: false,
  dryRun: false,
  stepThrough: false,
});

export const createWorkflow = (name = "New Workflow"): WorkflowDefinition => ({
  id: uuidv4(),
  name,
  steps: [],
  updatedAt: new Date().toISOString(),
});

export const createStep = (type: WorkflowStep["type"]): WorkflowStep => ({
  id: uuidv4(),
  type,
});

export const createJob = (
  name: string,
  workflowId: string,
  fileName: string,
  headers: string[],
  rows: CsvRow[],
): Job => ({
  id: uuidv4(),
  name,
  workflowId,
  csvFileName: fileName,
  headers,
  rows,
  createdAt: new Date().toISOString(),
});

export const createRun = (jobId: string, settings: RunSettings): Run => ({
  id: uuidv4(),
  jobId,
  status: "idle",
  currentRowIndex: 0,
  currentStepIndex: 0,
  lastCompletedRow: -1,
  successCount: 0,
  failureCount: 0,
  logs: [],
  rowResults: [],
  settings,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
