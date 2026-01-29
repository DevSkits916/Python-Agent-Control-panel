import Dexie, { type Table } from "dexie";
import type { Job, Run, RunLog, RowResult } from "../state";
import type { WorkflowDefinition } from "@shared/schema";
import {
  ACPExportSchema,
  JobSchema,
  RowResultSchema,
  RunLogSchema,
  RunSchema,
  WorkflowDefinitionSchema,
} from "@shared/validators";

const LEGACY_STATE_KEY = "acp:state";
const LEGACY_BACKUP_KEY = "acp:legacy-backup";

export const EXPORT_VERSION = 1;

export type MetaEntry = {
  key: string;
  value: string;
};

export type RunRecord = Omit<Run, "logs" | "rowResults">;

export class ACPDatabase extends Dexie {
  workflows!: Table<WorkflowDefinition, string>;
  jobs!: Table<Job, string>;
  runs!: Table<RunRecord, string>;
  logs!: Table<RunLog, string>;
  rowResults!: Table<RowResult & { id: string }, string>;
  meta!: Table<MetaEntry, string>;

  constructor() {
    super("acp-db");
    this.version(1).stores({
      workflows: "id, updatedAt",
      jobs: "id, workflowId, createdAt",
      runs: "id, jobId, status, updatedAt",
      logs: "id, runId, rowIndex",
      rowResults: "id, runId, rowIndex",
      meta: "key",
    });
  }
}

export const db = new ACPDatabase();

export const migrateLegacyState = async () => {
  const raw = localStorage.getItem(LEGACY_STATE_KEY);
  if (!raw) {
    return false;
  }
  localStorage.setItem(LEGACY_BACKUP_KEY, raw);
  try {
  const parsed = JSON.parse(raw) as {
      workflows?: WorkflowDefinition[];
      jobs?: Job[];
      runs?: Run[];
    };
    const workflows = (parsed.workflows ?? []).filter((workflow) =>
      WorkflowDefinitionSchema.safeParse(workflow).success,
    );
    const jobs = (parsed.jobs ?? []).filter((job) => JobSchema.safeParse(job).success);
    const runs = (parsed.runs ?? []).filter((run) => RunSchema.safeParse(run).success);
    await db.transaction("rw", db.workflows, db.jobs, db.runs, db.logs, db.rowResults, async () => {
      if (workflows.length) {
        await db.workflows.bulkPut(workflows);
      }
      if (jobs.length) {
        await db.jobs.bulkPut(jobs);
      }
      if (runs.length) {
        const runRecords: RunRecord[] = runs.map(({ logs, rowResults, ...rest }) => rest);
        await db.runs.bulkPut(runRecords);
      }
      for (const run of runs) {
        if (run.logs?.length) {
          const logs = run.logs
            .map((log) => ({ ...log, runId: run.id }))
            .filter((log) => RunLogSchema.safeParse(log).success);
          if (logs.length) {
            await db.logs.bulkPut(logs);
          }
        }
        if (run.rowResults?.length) {
          const results = run.rowResults
            .map((result) => ({
              ...result,
              id: `${run.id}:${result.rowIndex}`,
              runId: run.id,
            }))
            .filter((result) => RowResultSchema.safeParse(result).success);
          if (results.length) {
            await db.rowResults.bulkPut(results);
          }
        }
      }
    });
  } catch {
    return false;
  } finally {
    localStorage.removeItem(LEGACY_STATE_KEY);
  }
  return true;
};

export const loadAllData = async () => {
  const [workflows, jobs, runs, logs, rowResults] = await Promise.all([
    db.workflows.toArray(),
    db.jobs.toArray(),
    db.runs.toArray(),
    db.logs.toArray(),
    db.rowResults.toArray(),
  ]);
  return {
    workflows,
    jobs,
    runs,
    logs,
    rowResults,
  };
};

export const exportAllData = async () => {
  const data = await loadAllData();
  const payload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workflows: data.workflows,
    jobs: data.jobs,
    runs: data.runs,
    logs: data.logs,
    rowResults: data.rowResults.map(({ id, ...rest }) => rest),
  };
  return ACPExportSchema.parse(payload);
};

export const importAllData = async (payload: unknown) => {
  const parsed = ACPExportSchema.parse(payload);
  await db.transaction("rw", db.workflows, db.jobs, db.runs, db.logs, db.rowResults, async () => {
    await Promise.all([
      db.workflows.clear(),
      db.jobs.clear(),
      db.runs.clear(),
      db.logs.clear(),
      db.rowResults.clear(),
    ]);
    await db.workflows.bulkPut(parsed.workflows);
    await db.jobs.bulkPut(parsed.jobs);
    await db.runs.bulkPut(parsed.runs);
    await db.logs.bulkPut(parsed.logs);
    await db.rowResults.bulkPut(
      parsed.rowResults.map((result) => ({
        ...result,
        id: `${result.runId}:${result.rowIndex}`,
      })),
    );
  });
};

export const getLegacyBackup = () => localStorage.getItem(LEGACY_BACKUP_KEY);

export const clearLegacyBackup = () => localStorage.removeItem(LEGACY_BACKUP_KEY);
