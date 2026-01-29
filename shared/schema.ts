import schema from "./message-schema.json";

export type MessageType = keyof typeof schema.types;

export type ControlStartRunMessage = {
  type: "CONTROL_START_RUN";
  payload: {
    runId: string;
    jobId: string;
    workflow: WorkflowDefinition;
    rows: CsvRow[];
    settings: RunSettings;
    resumeFrom: number;
  };
};

export type ControlPauseRunMessage = {
  type: "CONTROL_PAUSE_RUN";
  payload: { runId: string };
};

export type ControlResumeRunMessage = {
  type: "CONTROL_RESUME_RUN";
  payload: { runId: string };
};

export type ControlStopRunMessage = {
  type: "CONTROL_STOP_RUN";
  payload: { runId: string };
};

export type ControlKillSwitchMessage = {
  type: "CONTROL_KILL_SWITCH";
  payload: { enabled: boolean };
};

export type AgentStatusMessage = {
  type: "AGENT_STATUS";
  payload: {
    runId: string;
    status: "idle" | "running" | "paused" | "stopped" | "error" | "complete";
    currentRowIndex: number;
    message: string;
    successCount: number;
    failureCount: number;
  };
};

export type AgentLogMessage = {
  type: "AGENT_LOG";
  payload: {
    runId: string;
    rowIndex: number;
    stepIndex: number;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    timestamp: string;
  };
};

export type AgentRowResultMessage = {
  type: "AGENT_ROW_RESULT";
  payload: {
    runId: string;
    rowIndex: number;
    status: "success" | "failed" | "skipped";
    error: string | null;
    artifacts: {
      screenshot?: string;
      htmlSnapshot?: string;
    };
  };
};

export type ACPMessage =
  | ControlStartRunMessage
  | ControlPauseRunMessage
  | ControlResumeRunMessage
  | ControlStopRunMessage
  | ControlKillSwitchMessage
  | AgentStatusMessage
  | AgentLogMessage
  | AgentRowResultMessage;

export type WorkflowStepType =
  | "goto"
  | "click"
  | "type"
  | "press"
  | "wait_for_selector"
  | "wait_time"
  | "screenshot"
  | "evaluate"
  | "set_var"
  | "conditional";

export type WorkflowStep = {
  id: string;
  type: WorkflowStepType;
  selector?: string;
  value?: string;
  timeoutMs?: number;
  retries?: number;
  notes?: string;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  steps: WorkflowStep[];
  updatedAt: string;
};

export type RunSettings = {
  headless: boolean;
  slowMoMs: number;
  timeoutMs: number;
  delayMinMs: number;
  delayMaxMs: number;
  concurrency: number;
  bestEffort: boolean;
  storageState?: string;
};

export type CsvRow = Record<string, string>;

export const MESSAGE_CHANNEL = schema.channel;

export const MESSAGE_VERSION = schema.version;

const baseTypeKeys = Object.keys(schema.types);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const hasKeys = (value: Record<string, unknown>, keys: string[]) =>
  keys.every((key) => key in value);

export const validateMessage = (message: unknown): message is ACPMessage => {
  if (!isObject(message) || typeof message.type !== "string") {
    return false;
  }
  if (!baseTypeKeys.includes(message.type)) {
    return false;
  }
  if (!("payload" in message) || !isObject(message.payload)) {
    return false;
  }
  const payloadSchema = schema.types[message.type as MessageType];
  const requiredKeys = Object.keys(payloadSchema);
  return hasKeys(message.payload, requiredKeys);
};
