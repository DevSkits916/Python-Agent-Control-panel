import React, { useEffect, useMemo, useRef, useState } from "react";
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
  createDefaultWorkflow,
  createJob,
  createRun,
  createStep,
  createWorkflow,
} from "./state";
import { formatTimestamp } from "./utils";
import { loadSettings, saveSettings } from "./storage/settings";
import {
  db,
  exportAllData,
  getLegacyBackup,
  importAllData,
  loadAllData,
  migrateLegacyState,
  type RunRecord,
} from "./storage/db";

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

const toRunRecord = (run: Run): RunRecord => {
  const { logs, rowResults, ...record } = run;
  return record;
};

type AgentConnection = {
  status: "unknown" | "connected" | "offline";
  lastPingAt: string | null;
  lastHelloAt: string | null;
  tabUrl: string | null;
  site: string | null;
};

const App: React.FC = () => {
  const [state, setState] = useState<ACPState>(() => {
    const settings = loadSettings();
    return {
      workflows: [],
      jobs: [],
      runs: [],
      debugEnabled: settings.debugEnabled,
      killSwitchEnabled: settings.killSwitchEnabled,
    };
  });
  const [connection, setConnection] = useState<AgentConnection>({
    status: "unknown",
    lastPingAt: null,
    lastHelloAt: null,
    tabUrl: null,
    site: null,
  });
  const [legacyBackup, setLegacyBackup] = useState<string | null>(getLegacyBackup());
  const [dataLoaded, setDataLoaded] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [activeTab, setActiveTab] = useState<"dashboard" | "workflows" | "runs" | "settings">(
    "dashboard",
  );
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const workflows = state.workflows;
  const jobs = state.jobs;
  const runs = state.runs;

  useEffect(() => {
    saveSettings({
      debugEnabled: state.debugEnabled,
      killSwitchEnabled: state.killSwitchEnabled,
    });
  }, [state.debugEnabled, state.killSwitchEnabled]);

  useEffect(() => {
    let active = true;
    const hydrate = async () => {
      await migrateLegacyState();
      const data = await loadAllData();
      if (!active) {
        return;
      }
      const runsById = new Map<string, Run>();
      data.runs.forEach((run) => {
        runsById.set(run.id, {
          ...run,
          currentStepIndex: run.currentStepIndex ?? 0,
          logs: [],
          rowResults: [],
        });
      });
      data.logs.forEach((log) => {
        const run = runsById.get(log.runId);
        if (run) {
          run.logs.push(log);
        }
      });
      data.rowResults.forEach((result) => {
        const run = runsById.get(result.runId);
        if (run) {
          const { id: _id, ...rest } = result;
          run.rowResults.push(rest);
        }
      });
      const workflows =
        data.workflows.length > 0 ? data.workflows : [createDefaultWorkflow()];
      if (data.workflows.length === 0) {
        await db.workflows.bulkPut(workflows);
      }
      setState((prev) => ({
        ...prev,
        workflows,
        jobs: data.jobs,
        runs: Array.from(runsById.values()),
      }));
      setLegacyBackup(getLegacyBackup());
      setDataLoaded(true);
    };
    void hydrate();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    transport.send({
      type: "CONTROL_KILL_SWITCH",
      payload: {
        requestId: transport.createRequestId(),
        enabled: state.killSwitchEnabled,
      },
    });
  }, [state.killSwitchEnabled]);

  useEffect(() => {
    const unsubscribe = transport.subscribe((message) => {
      setState((prev) => handleMessage(prev, message, setConnection));
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      transport.send({
        type: "CONTROL_PING",
        payload: { requestId: transport.createRequestId() },
      });
    }, 5000);
    transport.send({
      type: "CONTROL_HELLO",
      payload: {
        requestId: transport.createRequestId(),
        appVersion: "1.0.0",
        protocolVersion: "1.1.0",
      },
    });
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setConnection((prev) => {
        if (!prev.lastPingAt) {
          return prev;
        }
        const ageMs = Date.now() - new Date(prev.lastPingAt).getTime();
        if (ageMs > 15000 && prev.status === "connected") {
          return { ...prev, status: "offline" };
        }
        return prev;
      });
    }, 5000);
    return () => window.clearInterval(interval);
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
    const workflow = createWorkflow(name);
    setState((prev) => ({
      ...prev,
      workflows: [...prev.workflows, workflow],
    }));
    void db.workflows.put(workflow);
    setActiveTab("workflows");
  };

  const handleDeleteWorkflow = (workflowId: string) => {
    setState((prev) => ({
      ...prev,
      workflows: prev.workflows.filter((workflow) => workflow.id !== workflowId),
    }));
    void db.workflows.delete(workflowId);
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
      const job = createJob(name, workflowId, file.name, headers, rows);
      setState((prev) => ({
        ...prev,
        jobs: [...prev.jobs, job],
      }));
      void db.jobs.put(job);
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
    if (state.killSwitchEnabled) {
      alert("Kill switch is enabled. Disable it in Settings to start a run.");
      return;
    }
    const settings = createDefaultSettings();
    const run = createRun(job.id, settings);
    const workflow = workflows.find((flow) => flow.id === job.workflowId);
    if (!workflow) {
      alert("Workflow not found.");
      return;
    }
    const preparedRows = prepareRowsForRun(job.rows);
    const startMessage = {
      type: "CONTROL_START_RUN",
      payload: {
        requestId: transport.createRequestId(),
        runId: run.id,
        jobId: job.id,
        workflow,
        rows: preparedRows,
        settings,
        resumeFrom: run.lastCompletedRow + 1,
      },
    } as const;
    transport
      .sendCommand(startMessage)
      .catch((error) => alert(`Agent did not acknowledge the run: ${error.message}`));
    const runningRun = { ...run, status: "running", updatedAt: new Date().toISOString() };
    setState((prev) => ({
      ...prev,
      runs: [
        {
          ...runningRun,
        },
        ...prev.runs,
      ],
    }));
    void db.runs.put(toRunRecord(runningRun));
    setSelectedRunId(run.id);
    setActiveTab("runs");
  };

  const handlePauseRun = (run: Run) => {
    transport
      .sendCommand({
        type: "CONTROL_PAUSE_RUN",
        payload: { requestId: transport.createRequestId(), runId: run.id },
      })
      .catch((error) => alert(`Pause failed: ${error.message}`));
    setState((prev) => ({
      ...prev,
      runs: prev.runs.map((item) =>
        item.id === run.id ? { ...item, status: "paused", updatedAt: new Date().toISOString() } : item,
      ),
    }));
    void db.runs.put(toRunRecord({ ...run, status: "paused", updatedAt: new Date().toISOString() }));
  };

  const handleResumeRun = (run: Run) => {
    transport
      .sendCommand({
        type: "CONTROL_RESUME_RUN",
        payload: { requestId: transport.createRequestId(), runId: run.id },
      })
      .catch((error) => alert(`Resume failed: ${error.message}`));
    setState((prev) => ({
      ...prev,
      runs: prev.runs.map((item) =>
        item.id === run.id ? { ...item, status: "running", updatedAt: new Date().toISOString() } : item,
      ),
    }));
    void db.runs.put(toRunRecord({ ...run, status: "running", updatedAt: new Date().toISOString() }));
  };

  const handleStopRun = (run: Run) => {
    transport
      .sendCommand({
        type: "CONTROL_STOP_RUN",
        payload: { requestId: transport.createRequestId(), runId: run.id },
      })
      .catch((error) => alert(`Stop failed: ${error.message}`));
    setState((prev) => ({
      ...prev,
      runs: prev.runs.map((item) =>
        item.id === run.id ? { ...item, status: "stopped", updatedAt: new Date().toISOString() } : item,
      ),
    }));
    void db.runs.put(toRunRecord({ ...run, status: "stopped", updatedAt: new Date().toISOString() }));
  };

  const handleStepNext = (run: Run) => {
    transport
      .sendCommand({
        type: "CONTROL_STEP_NEXT",
        payload: {
          requestId: transport.createRequestId(),
          runId: run.id,
          rowIndex: run.currentRowIndex,
          stepIndex: run.currentStepIndex,
        },
      })
      .catch((error) => alert(`Step signal failed: ${error.message}`));
  };

  const handleUpdateSettings = (run: Run, updates: Partial<Run["settings"]>) => {
    const updated = {
      ...run,
      settings: { ...run.settings, ...updates },
      updatedAt: new Date().toISOString(),
    };
    setState((prev) => ({
      ...prev,
      runs: prev.runs.map((item) =>
        item.id === run.id ? updated : item,
      ),
    }));
    void db.runs.put(toRunRecord(updated));
  };

  const handleDebugToggle = () => {
    setState((prev) => {
      const next = !prev.debugEnabled;
      localStorage.setItem("acp:debug", JSON.stringify(next));
      return { ...prev, debugEnabled: next };
    });
  };

  const handleKillSwitchToggle = () => {
    setState((prev) => {
      const next = !prev.killSwitchEnabled;
      transport.send({
        type: "CONTROL_KILL_SWITCH",
        payload: { requestId: transport.createRequestId(), enabled: next },
      });
      return { ...prev, killSwitchEnabled: next };
    });
  };

  const handleExportAllData = async () => {
    const payload = await exportAllData();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `acp-export-${new Date().toISOString()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleImportAllData = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      await importAllData(payload);
      const data = await loadAllData();
      const runsById = new Map<string, Run>();
      data.runs.forEach((run) => {
        runsById.set(run.id, {
          ...run,
          currentStepIndex: run.currentStepIndex ?? 0,
          logs: [],
          rowResults: [],
        });
      });
      data.logs.forEach((log) => {
        const run = runsById.get(log.runId);
        if (run) {
          run.logs.push(log);
        }
      });
      data.rowResults.forEach((result) => {
        const run = runsById.get(result.runId);
        if (run) {
          const { id: _id, ...rest } = result;
          run.rowResults.push(rest);
        }
      });
      setState((prev) => ({
        ...prev,
        workflows: data.workflows,
        jobs: data.jobs,
        runs: Array.from(runsById.values()),
      }));
      alert("Import complete.");
    } catch (error) {
      alert(`Import failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      event.target.value = "";
    }
  };

  const handleReHandshake = () => {
    transport.send({
      type: "CONTROL_HELLO",
      payload: {
        requestId: transport.createRequestId(),
        appVersion: "1.0.0",
        protocolVersion: "1.1.0",
      },
    });
  };

  const handleCopyDebugBundle = async () => {
    const payload = await exportAllData();
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    alert("Debug bundle copied to clipboard.");
  };

  const handleOpenDiagnostics = async () => {
    const payload = await exportAllData();
    const diagnostics = {
      exportedAt: new Date().toISOString(),
      connection,
      data: payload,
    };
    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const handleDownloadLegacyBackup = () => {
    if (!legacyBackup) {
      return;
    }
    const blob = new Blob([legacyBackup], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "acp-legacy-backup.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const handleExportRunReport = (run: Run) => {
    const job = jobs.find((item) => item.id === run.jobId);
    if (!job) {
      alert("Job data not found for this run.");
      return;
    }
    const resultsByRow = new Map(run.rowResults.map((result) => [result.rowIndex, result]));
    const reportRows = job.rows.map((row, index) => {
      const result = resultsByRow.get(index);
      return {
        rowIndex: String(index),
        status: result?.status ?? "pending",
        error: result?.error ?? "",
        durationMs: result?.durationMs ? String(result.durationMs) : "",
        ...row,
      };
    });
    const headers = ["rowIndex", "status", "error", "durationMs", ...job.headers];
    const csv = serializeCsv(headers, reportRows);
    const jsonPayload = {
      run,
      job,
      rows: reportRows,
      logs: run.logs,
    };
    const csvBlob = new Blob([csv], { type: "text/csv" });
    const csvLink = document.createElement("a");
    csvLink.href = URL.createObjectURL(csvBlob);
    csvLink.download = `run-${run.id}-report.csv`;
    csvLink.click();
    URL.revokeObjectURL(csvLink.href);
    const jsonBlob = new Blob([JSON.stringify(jsonPayload, null, 2)], {
      type: "application/json",
    });
    const jsonLink = document.createElement("a");
    jsonLink.href = URL.createObjectURL(jsonBlob);
    jsonLink.download = `run-${run.id}-report.json`;
    jsonLink.click();
    URL.revokeObjectURL(jsonLink.href);
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
        <section className="panel panel--warning">
          <p>
            ⚠️ You are responsible for complying with the target site’s Terms of Service and
            automation policies. Use rate limits, avoid aggressive automation, and monitor runs.
          </p>
        </section>
        {!dataLoaded && (
          <section className="panel">
            <p className="muted">Loading data from IndexedDB…</p>
          </section>
        )}
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
                  onUpdate={(updated) => {
                    setState((prev) => ({
                      ...prev,
                      workflows: prev.workflows.map((flow) => (flow.id === workflow.id ? updated : flow)),
                    }));
                    void db.workflows.put(updated);
                  }}
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
                    onStepNext={handleStepNext}
                    onExportReport={handleExportRunReport}
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
              <h3>Connection</h3>
              <p>
                Status: <strong>{connection.status}</strong>
              </p>
              <p className="muted">
                Last hello: {connection.lastHelloAt ? formatTimestamp(connection.lastHelloAt) : "—"}
              </p>
              <p className="muted">
                Last ping: {connection.lastPingAt ? formatTimestamp(connection.lastPingAt) : "—"}
              </p>
              <p className="muted">Tab URL: {connection.tabUrl ?? "—"}</p>
              <p className="muted">Site: {connection.site ?? "—"}</p>
              <div className="card__actions">
                <button type="button" className="button secondary" onClick={handleReHandshake}>
                  Re-handshake
                </button>
                <button type="button" className="button secondary" onClick={handleOpenDiagnostics}>
                  Open diagnostics
                </button>
                <button type="button" className="button secondary" onClick={handleCopyDebugBundle}>
                  Copy debug bundle
                </button>
              </div>
            </div>
            <div className="card">
              <label className="toggle">
                <input type="checkbox" checked={state.debugEnabled} onChange={handleDebugToggle} />
                Enable debug logging
              </label>
              <p className="muted">
                Debug logs are shared with the automation userscript through localStorage.
              </p>
              <label className="toggle toggle--danger">
                <input
                  type="checkbox"
                  checked={state.killSwitchEnabled}
                  onChange={handleKillSwitchToggle}
                />
                Emergency kill switch (stops all runs)
              </label>
              <p className="muted">
                When enabled, the userscript will stop active runs and ignore new run commands until
                you disable it.
              </p>
            </div>
            <div className="card">
              <h3>Data management</h3>
              <div className="card__actions">
                <button type="button" className="button secondary" onClick={handleExportAllData}>
                  Export All Data
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => importInputRef.current?.click()}
                >
                  Import Data
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json"
                  onChange={handleImportAllData}
                  hidden
                />
              </div>
              {legacyBackup && (
                <div className="card__actions">
                  <button
                    type="button"
                    className="button secondary"
                    onClick={handleDownloadLegacyBackup}
                  >
                    Download legacy backup
                  </button>
                </div>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

const handleMessage = (
  state: ACPState,
  message: ACPMessage,
  setConnection: React.Dispatch<React.SetStateAction<AgentConnection>>,
): ACPState => {
  switch (message.type) {
    case "AGENT_HELLO":
      setConnection(() => ({
        status: "connected",
        lastHelloAt: new Date().toISOString(),
        lastPingAt: null,
        tabUrl: message.payload.tabUrl,
        site: message.payload.site,
      }));
      return state;
    case "AGENT_PONG":
      setConnection((prev) => ({
        ...prev,
        status: "connected",
        lastPingAt: new Date().toISOString(),
        tabUrl: message.payload.tabUrl,
        site: message.payload.site,
      }));
      return state;
    case "AGENT_STATUS": {
      const { nextState, updatedRun } = updateRunStatus(state, message);
      if (updatedRun) {
        void db.runs.put(toRunRecord(updatedRun));
      }
      return nextState;
    }
    case "AGENT_LOG": {
      const { nextState, logEntry, updatedRun } = appendRunLog(state, message);
      if (logEntry) {
        void db.logs.put(logEntry);
      }
      if (updatedRun) {
        void db.runs.put(toRunRecord(updatedRun));
      }
      return nextState;
    }
    case "AGENT_ROW_RESULT": {
      const { nextState, rowResult, updatedRun } = appendRowResult(state, message);
      if (rowResult) {
        void db.rowResults.put({ ...rowResult, id: `${rowResult.runId}:${rowResult.rowIndex}` });
      }
      if (updatedRun) {
        void db.runs.put(toRunRecord(updatedRun));
      }
      return nextState;
    }
    default:
      return state;
  }
};

const updateRunStatus = (state: ACPState, message: AgentStatusMessage) => {
  let updatedRun: Run | null = null;
  const runs = state.runs.map((run) => {
    if (run.id !== message.payload.runId) {
      return run;
    }
    const rowChanged = run.currentRowIndex !== message.payload.currentRowIndex;
    const next = {
      ...run,
      status: message.payload.status,
      currentRowIndex: message.payload.currentRowIndex,
      currentStepIndex: rowChanged ? 0 : run.currentStepIndex,
      successCount: message.payload.successCount,
      failureCount: message.payload.failureCount,
      updatedAt: new Date().toISOString(),
    };
    updatedRun = next;
    return next;
  });
  return { nextState: { ...state, runs }, updatedRun };
};

const appendRunLog = (state: ACPState, message: AgentLogMessage) => {
  let logEntry: Run["logs"][number] | null = null;
  let updatedRun: Run | null = null;
  const runs = state.runs.map((run) => {
    if (run.id !== message.payload.runId) {
      return run;
    }
    logEntry = {
      id: `${message.payload.runId}-${message.payload.rowIndex}-${message.payload.stepIndex}-${message.payload.timestamp}`,
      runId: message.payload.runId,
      rowIndex: message.payload.rowIndex,
      stepIndex: message.payload.stepIndex,
      level: message.payload.level,
      message: message.payload.message,
      timestamp: message.payload.timestamp,
    };
    const next = {
      ...run,
      logs: logEntry ? [logEntry, ...run.logs] : run.logs,
      currentStepIndex: message.payload.stepIndex + 1,
      updatedAt: new Date().toISOString(),
    };
    updatedRun = next;
    return next;
  });
  return { nextState: { ...state, runs }, logEntry, updatedRun };
};

const appendRowResult = (state: ACPState, message: AgentRowResultMessage) => {
  let rowResult: Run["rowResults"][number] | null = null;
  let updatedRun: Run | null = null;
  const runs = state.runs.map((run) => {
    if (run.id !== message.payload.runId) {
      return run;
    }
    rowResult = {
      runId: message.payload.runId,
      rowIndex: message.payload.rowIndex,
      status: message.payload.status,
      error: message.payload.error,
      artifacts: message.payload.artifacts,
      durationMs: message.payload.durationMs,
    };
    const next = {
      ...run,
      rowResults: rowResult ? [rowResult, ...run.rowResults] : run.rowResults,
      lastCompletedRow: Math.max(run.lastCompletedRow, message.payload.rowIndex),
      updatedAt: new Date().toISOString(),
    };
    updatedRun = next;
    return next;
  });
  return { nextState: { ...state, runs }, rowResult, updatedRun };
};

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
  onStepNext: (run: Run) => void;
  onExportReport: (run: Run) => void;
  onUpdateSettings: (run: Run, updates: Partial<Run["settings"]>) => void;
}> = ({ run, job, onPause, onResume, onStop, onStepNext, onExportReport, onUpdateSettings }) => (
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
        <strong>Step</strong>
        <span>{run.currentStepIndex + 1}</span>
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
      {run.settings.stepThrough && (
        <button type="button" className="button" onClick={() => onStepNext(run)}>
          Next Step
        </button>
      )}
      <button type="button" className="button secondary" onClick={() => onExportReport(run)}>
        Export Run Report
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
      <label>
        Dry Run
        <select
          value={String(run.settings.dryRun)}
          onChange={(event) => onUpdateSettings(run, { dryRun: event.target.value === "true" })}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      </label>
      <label>
        Step Through
        <select
          value={String(run.settings.stepThrough)}
          onChange={(event) => onUpdateSettings(run, { stepThrough: event.target.value === "true" })}
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
            {result.durationMs !== undefined && (
              <p className="muted">Duration: {result.durationMs} ms</p>
            )}
            {result.error && <p className="error">{result.error}</p>}
            {result.artifacts?.screenshot && (
              <a href={result.artifacts.screenshot} target="_blank" rel="noreferrer">
                Screenshot
              </a>
            )}
            {result.artifacts?.htmlSnapshot && (
              <a href={result.artifacts.htmlSnapshot} target="_blank" rel="noreferrer">
                DOM Snapshot
              </a>
            )}
            {result.artifacts?.consoleLogs?.length ? (
              <details>
                <summary>Console Logs</summary>
                <pre className="pre">{result.artifacts.consoleLogs.join("\n")}</pre>
              </details>
            ) : null}
          </div>
        ))
      )}
    </div>
  </div>
);

export default App;
