import React, { useEffect, useMemo, useState } from "react";
import {
  ACPMessage,
  AgentLogMessage,
  AgentRowResultMessage,
  AgentStatusMessage,
  WorkflowStepType,
} from "@shared/schema";
import { parseCsv, serializeCsv } from "@shared/csv";
import { pickNextPost } from "@shared/similarity";
import { ACPTransport } from "./transport";
import {
  ACPState,
  Job,
  Run,
  createDefaultSettings,
  createJob,
  createRun,
  createStep,
  createWorkflow,
  loadState,
  saveState,
} from "./state";
import { formatTimestamp } from "./utils";

const transport = new ACPTransport();

const stepTypes: WorkflowStepType[] = [
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
];

const prepareRowsForRun = (rows: Job["rows"]) => {
  const processed: Job["rows"] = [];
  const recentPosts: string[] = [];
  rows.forEach((row) => {
    const postOptions = row.post_options
      ? row.post_options.split("|").map((value) => value.trim()).filter(Boolean)
      : row.post
        ? [row.post]
        : [];
    if (postOptions.length > 0) {
      const selection = pickNextPost(postOptions, recentPosts);
      const nextRow = {
        ...row,
        post: selection.value,
        post_reason: selection.reason,
      };
      processed.push(nextRow);
      recentPosts.unshift(selection.value);
      if (recentPosts.length > 5) {
        recentPosts.pop();
      }
    } else {
      processed.push(row);
    }
  });
  return processed;
};

const App: React.FC = () => {
  const [state, setState] = useState<ACPState>(() => loadState());
  const [activeTab, setActiveTab] = useState<"dashboard" | "workflows" | "runs" | "settings">(
    "dashboard",
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const workflows = state.workflows;
  const jobs = state.jobs;
  const runs = state.runs;

  useEffect(() => {
    saveState(state);
  }, [state]);

  useEffect(() => {
    const unsubscribe = transport.subscribe((message) => {
      setState((prev) => handleMessage(prev, message));
    });
    return () => unsubscribe();
  }, []);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null,
    [jobs, selectedJobId],
  );

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null,
    [runs, selectedRunId],
  );

  const handleCreateWorkflow = () => {
    const name = prompt("Workflow name")?.trim();
    if (!name) {
      return;
    }
    setState((prev) => ({
      ...prev,
      workflows: [...prev.workflows, createWorkflow(name)],
    }));
    setActiveTab("workflows");
  };

  const handleDeleteWorkflow = (workflowId: string) => {
    setState((prev) => ({
      ...prev,
      workflows: prev.workflows.filter((workflow) => workflow.id !== workflowId),
    }));
  };

  const handleCreateJob = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const name = prompt("Job name")?.trim();
    if (!name) {
      return;
    }
    const workflowId = workflows[0]?.id;
    if (!workflowId) {
      alert("Create a workflow first.");
      return;
    }
    file.text().then((text) => {
      const { headers, rows } = parseCsv(text);
      setState((prev) => ({
        ...prev,
        jobs: [...prev.jobs, createJob(name, workflowId, file.name, headers, rows)],
      }));
      setActiveTab("dashboard");
    });
  };

  const handleExportCsv = (job: Job) => {
    const csv = serializeCsv(job.headers, job.rows);
    const blob = new Blob([csv], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = job.csvFileName || `${job.name}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleStartRun = (job: Job) => {
    const settings = createDefaultSettings();
    const run = createRun(job.id, settings);
    const workflow = workflows.find((flow) => flow.id === job.workflowId);
    if (!workflow) {
      alert("Workflow not found.");
      return;
    }
    const preparedRows = prepareRowsForRun(job.rows);
    transport.send({
      type: "CONTROL_START_RUN",
      payload: {
        runId: run.id,
        jobId: job.id,
        workflow,
        rows: preparedRows,
        settings,
        resumeFrom: run.lastCompletedRow + 1,
      },
    });
    setState((prev) => ({
      ...prev,
      runs: [
        {
          ...run,
          status: "running",
          updatedAt: new Date().toISOString(),
        },
        ...prev.runs,
      ],
    }));
    setSelectedRunId(run.id);
    setActiveTab("runs");
  };

  const handlePauseRun = (run: Run) => {
    transport.send({ type: "CONTROL_PAUSE_RUN", payload: { runId: run.id } });
    setState((prev) => ({
      ...prev,
      runs: prev.runs.map((item) =>
        item.id === run.id ? { ...item, status: "paused", updatedAt: new Date().toISOString() } : item,
      ),
    }));
  };

  const handleResumeRun = (run: Run) => {
    transport.send({ type: "CONTROL_RESUME_RUN", payload: { runId: run.id } });
    setState((prev) => ({
      ...prev,
      runs: prev.runs.map((item) =>
        item.id === run.id ? { ...item, status: "running", updatedAt: new Date().toISOString() } : item,
      ),
    }));
  };

  const handleStopRun = (run: Run) => {
    transport.send({ type: "CONTROL_STOP_RUN", payload: { runId: run.id } });
    setState((prev) => ({
      ...prev,
      runs: prev.runs.map((item) =>
        item.id === run.id ? { ...item, status: "stopped", updatedAt: new Date().toISOString() } : item,
      ),
    }));
  };

  const handleUpdateSettings = (run: Run, updates: Partial<Run["settings"]>) => {
    setState((prev) => ({
      ...prev,
      runs: prev.runs.map((item) =>
        item.id === run.id
          ? { ...item, settings: { ...item.settings, ...updates }, updatedAt: new Date().toISOString() }
          : item,
      ),
    }));
  };

  const handleDebugToggle = () => {
    setState((prev) => {
      const next = !prev.debugEnabled;
      localStorage.setItem("acp:debug", JSON.stringify(next));
      return { ...prev, debugEnabled: next };
    });
  };

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <p className="app__title">Agent Control Panel</p>
          <p className="app__subtitle">Local-first workflow runner for browser automations.</p>
        </div>
        <div className="app__actions">
          <button type="button" className="button secondary" onClick={handleCreateWorkflow}>
            New Workflow
          </button>
          <label className="button">
            Upload CSV
            <input type="file" accept=".csv" onChange={handleCreateJob} />
          </label>
        </div>
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={activeTab === "dashboard" ? "tab active" : "tab"}
          onClick={() => setActiveTab("dashboard")}
        >
          Dashboard
        </button>
        <button
          type="button"
          className={activeTab === "workflows" ? "tab active" : "tab"}
          onClick={() => setActiveTab("workflows")}
        >
          Workflows
        </button>
        <button
          type="button"
          className={activeTab === "runs" ? "tab active" : "tab"}
          onClick={() => setActiveTab("runs")}
        >
          Runs
        </button>
        <button
          type="button"
          className={activeTab === "settings" ? "tab active" : "tab"}
          onClick={() => setActiveTab("settings")}
        >
          Settings
        </button>
      </nav>

      <main className="app__content">
        {activeTab === "dashboard" && (
          <section className="panel">
            <h2>Jobs</h2>
            {jobs.length === 0 ? (
              <p className="muted">Upload a CSV to create a job.</p>
            ) : (
              <div className="grid">
                {jobs.map((job) => {
                  const workflow = workflows.find((flow) => flow.id === job.workflowId);
                  return (
                    <article key={job.id} className="card">
                      <div className="card__header">
                        <h3>{job.name}</h3>
                        <span className="pill">{job.rows.length} rows</span>
                      </div>
                      <p className="muted">Workflow: {workflow?.name ?? "Unknown"}</p>
                      <p className="muted">CSV: {job.csvFileName}</p>
                      <div className="card__actions">
                        <button type="button" className="button" onClick={() => handleStartRun(job)}>
                          Start Run
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => handleExportCsv(job)}
                        >
                          Export CSV
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {activeTab === "workflows" && (
          <section className="panel">
            <h2>Workflows</h2>
            {workflows.length === 0 ? (
              <p className="muted">Create a workflow to get started.</p>
            ) : (
              workflows.map((workflow) => (
                <WorkflowEditor
                  key={workflow.id}
                  workflow={workflow}
                  onDelete={() => handleDeleteWorkflow(workflow.id)}
                  onUpdate={(updated) =>
                    setState((prev) => ({
                      ...prev,
                      workflows: prev.workflows.map((flow) => (flow.id === workflow.id ? updated : flow)),
                    }))
                  }
                />
              ))
            )}
          </section>
        )}

        {activeTab === "runs" && (
          <section className="panel">
            <h2>Runs</h2>
            {runs.length === 0 ? (
              <p className="muted">No runs yet. Start a job to see activity.</p>
            ) : (
              <div className="grid two">
                <div className="list">
                  {runs.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      className={selectedRun?.id === run.id ? "list__item active" : "list__item"}
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      <div>
                        <strong>{run.id.slice(0, 8)}</strong>
                        <p className="muted">{run.status}</p>
                      </div>
                      <span className="pill">{run.currentRowIndex + 1}</span>
                    </button>
                  ))}
                </div>
                {selectedRun && (
                  <RunDetail
                    run={selectedRun}
                    job={jobs.find((job) => job.id === selectedRun.jobId) ?? null}
                    onPause={handlePauseRun}
                    onResume={handleResumeRun}
                    onStop={handleStopRun}
                    onUpdateSettings={handleUpdateSettings}
                  />
                )}
              </div>
            )}
          </section>
        )}

        {activeTab === "settings" && (
          <section className="panel">
            <h2>Settings</h2>
            <div className="card">
              <label className="toggle">
                <input type="checkbox" checked={state.debugEnabled} onChange={handleDebugToggle} />
                Enable debug logging
              </label>
              <p className="muted">
                Debug logs are shared with the automation userscript through localStorage.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

const handleMessage = (state: ACPState, message: ACPMessage): ACPState => {
  switch (message.type) {
    case "AGENT_STATUS":
      return updateRunStatus(state, message);
    case "AGENT_LOG":
      return appendRunLog(state, message);
    case "AGENT_ROW_RESULT":
      return appendRowResult(state, message);
    default:
      return state;
  }
};

const updateRunStatus = (state: ACPState, message: AgentStatusMessage) => ({
  ...state,
  runs: state.runs.map((run) =>
    run.id === message.payload.runId
      ? {
          ...run,
          status: message.payload.status,
          currentRowIndex: message.payload.currentRowIndex,
          successCount: message.payload.successCount,
          failureCount: message.payload.failureCount,
          updatedAt: new Date().toISOString(),
        }
      : run,
  ),
});

const appendRunLog = (state: ACPState, message: AgentLogMessage) => ({
  ...state,
  runs: state.runs.map((run) =>
    run.id === message.payload.runId
      ? {
          ...run,
          logs: [
            {
              id: `${message.payload.rowIndex}-${message.payload.stepIndex}-${message.payload.timestamp}`,
              rowIndex: message.payload.rowIndex,
              stepIndex: message.payload.stepIndex,
              level: message.payload.level,
              message: message.payload.message,
              timestamp: message.payload.timestamp,
            },
            ...run.logs,
          ],
          updatedAt: new Date().toISOString(),
        }
      : run,
  ),
});

const appendRowResult = (state: ACPState, message: AgentRowResultMessage) => ({
  ...state,
  runs: state.runs.map((run) =>
    run.id === message.payload.runId
      ? {
          ...run,
          rowResults: [
            {
              rowIndex: message.payload.rowIndex,
              status: message.payload.status,
              error: message.payload.error,
              artifacts: message.payload.artifacts,
            },
            ...run.rowResults,
          ],
          lastCompletedRow: Math.max(run.lastCompletedRow, message.payload.rowIndex),
          updatedAt: new Date().toISOString(),
        }
      : run,
  ),
});

const WorkflowEditor: React.FC<{
  workflow: ACPState["workflows"][number];
  onUpdate: (workflow: ACPState["workflows"][number]) => void;
  onDelete: () => void;
}> = ({ workflow, onUpdate, onDelete }) => {
  const [localWorkflow, setLocalWorkflow] = useState(workflow);
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    setLocalWorkflow(workflow);
  }, [workflow]);

  const updateWorkflow = (updates: Partial<typeof workflow>) => {
    const updated = { ...localWorkflow, ...updates, updatedAt: new Date().toISOString() };
    setLocalWorkflow(updated);
    onUpdate(updated);
  };

  const updateStep = (stepId: string, updates: Partial<typeof workflow.steps[number]>) => {
    const steps = localWorkflow.steps.map((step) =>
      step.id === stepId ? { ...step, ...updates } : step,
    );
    updateWorkflow({ steps });
  };

  const moveStep = (stepId: string, direction: number) => {
    const index = localWorkflow.steps.findIndex((step) => step.id === stepId);
    if (index < 0) {
      return;
    }
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= localWorkflow.steps.length) {
      return;
    }
    const steps = [...localWorkflow.steps];
    const [removed] = steps.splice(index, 1);
    steps.splice(nextIndex, 0, removed);
    updateWorkflow({ steps });
  };

  const handleJsonChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    try {
      const parsed = JSON.parse(event.target.value) as typeof workflow;
      if (!parsed.steps || !Array.isArray(parsed.steps)) {
        throw new Error("Steps must be an array.");
      }
      setJsonError(null);
      updateWorkflow({
        name: parsed.name,
        steps: parsed.steps.map((step) => ({ ...step, id: step.id ?? crypto.randomUUID() })),
      });
    } catch (error) {
      setJsonError((error as Error).message);
    }
  };

  return (
    <div className="card workflow">
      <div className="workflow__header">
        <input
          className="input"
          value={localWorkflow.name}
          onChange={(event) => updateWorkflow({ name: event.target.value })}
        />
        <button type="button" className="button secondary" onClick={onDelete}>
          Delete
        </button>
      </div>
      <div className="workflow__steps">
        {localWorkflow.steps.map((step, index) => (
          <div key={step.id} className="step">
            <div className="step__header">
              <strong>Step {index + 1}</strong>
              <div className="step__actions">
                <button type="button" onClick={() => moveStep(step.id, -1)}>
                  ↑
                </button>
                <button type="button" onClick={() => moveStep(step.id, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateWorkflow({ steps: localWorkflow.steps.filter((item) => item.id !== step.id) })
                  }
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="step__grid">
              <label>
                Type
                <select
                  value={step.type}
                  onChange={(event) => updateStep(step.id, { type: event.target.value as WorkflowStepType })}
                >
                  {stepTypes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Selector
                <input
                  className="input"
                  value={step.selector ?? ""}
                  onChange={(event) => updateStep(step.id, { selector: event.target.value })}
                />
              </label>
              <label>
                Value
                <input
                  className="input"
                  value={step.value ?? ""}
                  onChange={(event) => updateStep(step.id, { value: event.target.value })}
                />
              </label>
              <label>
                Timeout (ms)
                <input
                  className="input"
                  type="number"
                  value={step.timeoutMs ?? ""}
                  onChange={(event) =>
                    updateStep(step.id, { timeoutMs: Number(event.target.value || 0) || undefined })
                  }
                />
              </label>
              <label>
                Retries
                <input
                  className="input"
                  type="number"
                  value={step.retries ?? ""}
                  onChange={(event) =>
                    updateStep(step.id, { retries: Number(event.target.value || 0) || undefined })
                  }
                />
              </label>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="button secondary"
          onClick={() => updateWorkflow({ steps: [...localWorkflow.steps, createStep("goto")] })}
        >
          Add Step
        </button>
      </div>
      <div className="workflow__json">
        <label>
          Raw JSON
          <textarea
            className="textarea"
            value={JSON.stringify(localWorkflow, null, 2)}
            onChange={handleJsonChange}
          />
        </label>
        {jsonError && <p className="error">JSON Error: {jsonError}</p>}
      </div>
    </div>
  );
};

const RunDetail: React.FC<{
  run: Run;
  job: Job | null;
  onPause: (run: Run) => void;
  onResume: (run: Run) => void;
  onStop: (run: Run) => void;
  onUpdateSettings: (run: Run, updates: Partial<Run["settings"]>) => void;
}> = ({ run, job, onPause, onResume, onStop, onUpdateSettings }) => (
  <div className="card run-detail">
    <header>
      <h3>Run {run.id.slice(0, 8)}</h3>
      <p className="muted">
        Job: {job?.name ?? "Unknown"} | Created {formatTimestamp(run.createdAt)}
      </p>
    </header>
    <div className="stats">
      <div>
        <strong>Status</strong>
        <span>{run.status}</span>
      </div>
      <div>
        <strong>Row</strong>
        <span>
          {run.currentRowIndex + 1} / {job?.rows.length ?? 0}
        </span>
      </div>
      <div>
        <strong>Success</strong>
        <span>{run.successCount}</span>
      </div>
      <div>
        <strong>Failures</strong>
        <span>{run.failureCount}</span>
      </div>
    </div>
    <div className="card__actions">
      {run.status === "running" ? (
        <button type="button" className="button secondary" onClick={() => onPause(run)}>
          Pause
        </button>
      ) : (
        <button type="button" className="button" onClick={() => onResume(run)}>
          Resume
        </button>
      )}
      <button type="button" className="button secondary" onClick={() => onStop(run)}>
        Stop
      </button>
    </div>
    <div className="settings-grid">
      <label>
        Headless
        <select
          value={String(run.settings.headless)}
          onChange={(event) => onUpdateSettings(run, { headless: event.target.value === "true" })}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      </label>
      <label>
        SlowMo (ms)
        <input
          className="input"
          type="number"
          value={run.settings.slowMoMs}
          onChange={(event) => onUpdateSettings(run, { slowMoMs: Number(event.target.value) })}
        />
      </label>
      <label>
        Timeout (ms)
        <input
          className="input"
          type="number"
          value={run.settings.timeoutMs}
          onChange={(event) => onUpdateSettings(run, { timeoutMs: Number(event.target.value) })}
        />
      </label>
      <label>
        Delay Min (ms)
        <input
          className="input"
          type="number"
          value={run.settings.delayMinMs}
          onChange={(event) => onUpdateSettings(run, { delayMinMs: Number(event.target.value) })}
        />
      </label>
      <label>
        Delay Max (ms)
        <input
          className="input"
          type="number"
          value={run.settings.delayMaxMs}
          onChange={(event) => onUpdateSettings(run, { delayMaxMs: Number(event.target.value) })}
        />
      </label>
      <label>
        Best Effort
        <select
          value={String(run.settings.bestEffort)}
          onChange={(event) => onUpdateSettings(run, { bestEffort: event.target.value === "true" })}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      </label>
    </div>
    <div className="logs">
      <h4>Step Logs</h4>
      {run.logs.length === 0 ? (
        <p className="muted">No logs yet.</p>
      ) : (
        run.logs.slice(0, 50).map((log) => (
          <div key={log.id} className={`log log--${log.level}`}>
            <span>{formatTimestamp(log.timestamp)}</span>
            <strong>
              Row {log.rowIndex + 1} / Step {log.stepIndex + 1}
            </strong>
            <p>{log.message}</p>
          </div>
        ))
      )}
      <h4>Row Results</h4>
      {run.rowResults.length === 0 ? (
        <p className="muted">No row results yet.</p>
      ) : (
        run.rowResults.slice(0, 20).map((result) => (
          <div key={`${result.rowIndex}-${result.status}`} className="result">
            <strong>
              Row {result.rowIndex + 1}: {result.status}
            </strong>
            {result.error && <p className="error">{result.error}</p>}
            {result.artifacts?.screenshot && (
              <a href={result.artifacts.screenshot} target="_blank" rel="noreferrer">
                Screenshot
              </a>
            )}
          </div>
        ))
      )}
    </div>
  </div>
);

export default App;
