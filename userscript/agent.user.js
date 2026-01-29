// ==UserScript==
// @name         Agent Control Panel Runner
// @namespace    https://local.acp
// @version      1.0.0
// @description  Executes ACP workflows on Facebook-style pages with resilient selectors.
// @author       ACP
// @match        *://*.facebook.com/*
// @match        *://*.fb.com/*
// @match        *://*/*
// @grant        none
// ==/UserScript==

(() => {
  const MESSAGE_CHANNEL = "acp-control";
  const STORAGE_KEY = "acp:message";
  const DEBUG_KEY = "acp:debug";
  const MAX_BACKOFF_MS = 8000;

  const log = (level, message, context = {}) => {
    const debugEnabled = JSON.parse(localStorage.getItem(DEBUG_KEY) ?? "false");
    if (level === "debug" && !debugEnabled) {
      return;
    }
    const prefix = `[ACP ${level.toUpperCase()}]`;
    console[level === "error" ? "error" : "log"](prefix, message, context);
  };

  const storageState = {
    status: "idle",
    runId: null,
    currentRowIndex: -1,
    paused: false,
    stopped: false,
    killSwitchEnabled: false,
  };

  const listeners = new Set();

  const broadcast = (message) => {
    if (window.BroadcastChannel) {
      const channel = new BroadcastChannel(MESSAGE_CHANNEL);
      channel.postMessage(message);
      channel.close();
    }
    window.postMessage(message, "*");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
    localStorage.removeItem(STORAGE_KEY);
  };

  const handleIncoming = (message) => {
    if (!message || typeof message !== "object" || !message.type) {
      return;
    }
    listeners.forEach((listener) => listener(message));
  };

  if (window.BroadcastChannel) {
    const channel = new BroadcastChannel(MESSAGE_CHANNEL);
    channel.onmessage = (event) => handleIncoming(event.data);
  }

  window.addEventListener("message", (event) => handleIncoming(event.data));
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY && event.newValue) {
      try {
        const payload = JSON.parse(event.newValue);
        handleIncoming(payload);
      } catch {
        // ignore
      }
    }
  });

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const withTimeout = async (promise, timeoutMs, timeoutMessage) => {
    if (!timeoutMs) {
      return promise;
    }
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const retryWithBackoff = async (fn, retries = 0, timeoutMs = 0) => {
    let attempt = 0;
    while (true) {
      try {
        return await withTimeout(fn(), timeoutMs, "Step timeout exceeded");
      } catch (error) {
        if (attempt >= retries) {
          throw error;
        }
        const backoff = Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
        log("warn", `Retrying after ${backoff}ms`, { attempt, error });
        await delay(backoff);
        attempt += 1;
      }
    }
  };

  const resolveTemplate = (value, row, vars) => {
    if (!value) {
      return "";
    }
    return value.replace(/{{(.*?)}}/g, (_, rawKey) => {
      const key = rawKey.trim();
      if (key in vars) {
        return String(vars[key]);
      }
      if (!(key in row)) {
        throw new Error(`Missing template value for "${key}"`);
      }
      return String(row[key]);
    });
  };

  const querySelectorWithFallback = (selectors) => {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }
    return null;
  };

  const selectByText = (text) => {
    const elements = Array.from(document.querySelectorAll("button, [role='button'], a"));
    return elements.find((element) => element.textContent?.trim().includes(text)) ?? null;
  };

  const fbFallbacks = {
    "fb:composer": [
      "[role='textbox'][contenteditable='true']",
      "div[aria-label*='on your mind']",
      "div[aria-label*='Write something']",
      "div[role='combobox'] div[contenteditable='true']",
      "textarea[name='xhpc_message']",
    ],
    "fb:post-button": [
      "[aria-label*='Post']",
      "div[role='button'][aria-label*='Post']",
    ],
  };

  const findElement = (selector) => {
    if (!selector) {
      return null;
    }
    if (selector in fbFallbacks) {
      return querySelectorWithFallback(fbFallbacks[selector]);
    }
    if (selector.startsWith("text=")) {
      return selectByText(selector.replace("text=", ""));
    }
    const selectorList = selector.split("|").map((item) => item.trim());
    return querySelectorWithFallback(selectorList);
  };

  const clickElement = (selector) => {
    const element = findElement(selector) || selectByText(selector);
    if (!element) {
      throw new Error(`Unable to find element for selector: ${selector}`);
    }
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.click();
  };

  const typeIntoElement = (selector, value) => {
    const element = findElement(selector);
    if (!element) {
      throw new Error(`Unable to find input for selector: ${selector}`);
    }
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const pressKey = (selector, key) => {
    const element = selector ? findElement(selector) : document.activeElement;
    if (!element) {
      throw new Error("No active element to send keypress");
    }
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
  };

  const waitForSelector = async (selector, timeoutMs = 10000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (findElement(selector)) {
        return;
      }
      await delay(250);
    }
    throw new Error(`Timeout waiting for selector: ${selector}`);
  };

  const captureHtmlSnapshot = () => document.documentElement.outerHTML;

  const captureScreenshot = () => {
    const { width, height } = document.documentElement.getBoundingClientRect();
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
        <foreignObject width="100%" height="100%">
          ${new XMLSerializer().serializeToString(document.documentElement)}
        </foreignObject>
      </svg>
    `;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    return URL.createObjectURL(blob);
  };

  const applyDelay = async (min, max) => {
    const delayMs = Math.floor(min + Math.random() * (max - min));
    if (delayMs > 0) {
      await delay(delayMs);
    }
  };

  const sendStatus = (runId, status, state, message) => {
    broadcast({
      type: "AGENT_STATUS",
      payload: {
        runId,
        status,
        currentRowIndex: state.currentRowIndex,
        message,
        successCount: state.successCount,
        failureCount: state.failureCount,
      },
    });
  };

  const sendLog = (runId, rowIndex, stepIndex, level, message) => {
    broadcast({
      type: "AGENT_LOG",
      payload: {
        runId,
        rowIndex,
        stepIndex,
        level,
        message,
        timestamp: new Date().toISOString(),
      },
    });
  };

  const sendRowResult = (runId, rowIndex, status, error, artifacts) => {
    broadcast({
      type: "AGENT_ROW_RESULT",
      payload: {
        runId,
        rowIndex,
        status,
        error,
        artifacts,
      },
    });
  };

  const runWorkflow = async (payload) => {
    const { runId, workflow, rows, settings, resumeFrom } = payload;
    if (storageState.killSwitchEnabled) {
      sendStatus(runId, "stopped", storageState, "Kill switch enabled");
      sendLog(runId, 0, 0, "error", "Run blocked by kill switch");
      return;
    }
    storageState.status = "running";
    storageState.runId = runId;
    storageState.currentRowIndex = resumeFrom;
    storageState.paused = false;
    storageState.stopped = false;

    const state = {
      currentRowIndex: resumeFrom,
      successCount: 0,
      failureCount: 0,
    };

    sendStatus(runId, "running", state, "Run started");

    const vars = {};

    for (let rowIndex = resumeFrom; rowIndex < rows.length; rowIndex += 1) {
      if (storageState.killSwitchEnabled) {
        storageState.stopped = true;
      }
      if (storageState.stopped) {
        sendStatus(runId, "stopped", state, "Run stopped");
        return;
      }
      while (storageState.paused) {
        sendStatus(runId, "paused", state, "Run paused");
        await delay(500);
      }
      if (storageState.killSwitchEnabled) {
        storageState.stopped = true;
        sendStatus(runId, "stopped", state, "Kill switch enabled");
        return;
      }
      state.currentRowIndex = rowIndex;
      sendStatus(runId, "running", state, "Processing row");
      const row = rows[rowIndex];
      let rowFailed = false;
      let rowErrorMessage = "";
      for (let stepIndex = 0; stepIndex < workflow.steps.length; stepIndex += 1) {
        const step = workflow.steps[stepIndex];
        const retries = step.retries ?? 0;
        const timeoutMs = step.timeoutMs ?? settings.timeoutMs;
        try {
          await retryWithBackoff(
            async () => {
              await executeStep(step, row, vars, settings);
              sendLog(runId, rowIndex, stepIndex, "info", `Step ${step.type} completed`);
            },
            retries,
            timeoutMs,
          );
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          rowErrorMessage = errorMessage;
          sendLog(runId, rowIndex, stepIndex, "error", errorMessage);
          rowFailed = true;
          if (!settings.bestEffort) {
            break;
          }
        }
        await applyDelay(settings.delayMinMs, settings.delayMaxMs);
      }
      if (rowFailed) {
        state.failureCount += 1;
        const artifacts = {
          screenshot: captureScreenshot(),
          htmlSnapshot: captureHtmlSnapshot(),
        };
        sendRowResult(runId, rowIndex, "failed", rowErrorMessage || "Row failed during execution", artifacts);
        if (!settings.bestEffort) {
          sendStatus(runId, "error", state, "Row failed");
          return;
        }
      } else {
        state.successCount += 1;
        sendRowResult(runId, rowIndex, "success", null, {
          screenshot: captureScreenshot(),
          htmlSnapshot: captureHtmlSnapshot(),
        });
      }
    }

    sendStatus(runId, "complete", state, "Run complete");
  };

  const executeStep = async (step, row, vars, settings) => {
    const resolvedSelector = step.selector ? resolveTemplate(step.selector, row, vars) : null;
    const resolvedValue = step.value ? resolveTemplate(step.value, row, vars) : null;
    switch (step.type) {
      case "goto":
        if (!resolvedValue) {
          throw new Error("goto requires a value");
        }
        window.location.href = resolvedValue;
        break;
      case "click":
        if (!resolvedSelector && !resolvedValue) {
          throw new Error("click requires selector or value");
        }
        clickElement(resolvedSelector ?? resolvedValue);
        break;
      case "type":
        if (!resolvedSelector) {
          throw new Error("type requires selector");
        }
        typeIntoElement(resolvedSelector, resolvedValue ?? "");
        break;
      case "press":
        if (!resolvedValue) {
          throw new Error("press requires a key value");
        }
        pressKey(resolvedSelector, resolvedValue);
        break;
      case "wait_for_selector":
        if (!resolvedSelector) {
          throw new Error("wait_for_selector requires selector");
        }
        await waitForSelector(resolvedSelector, step.timeoutMs ?? settings.timeoutMs);
        break;
      case "wait_time":
        await delay(Number(resolvedValue ?? step.value ?? 0));
        break;
      case "screenshot":
        captureScreenshot();
        break;
      case "evaluate": {
        if (!resolvedValue) {
          throw new Error("evaluate requires code");
        }
        const fn = new Function("row", "vars", resolvedValue);
        fn(row, vars);
        break;
      }
      case "set_var":
        if (!resolvedValue || !step.selector) {
          throw new Error("set_var requires selector as key and value");
        }
        vars[step.selector] = resolvedValue;
        break;
      case "conditional": {
        if (!resolvedValue) {
          throw new Error("conditional requires value");
        }
        if (!resolvedValue || resolvedValue === "false") {
          throw new Error("Conditional failed");
        }
        break;
      }
      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  };

  listeners.add((message) => {
    if (message.type === "CONTROL_START_RUN") {
      if (storageState.killSwitchEnabled) {
        sendStatus(message.payload.runId, "stopped", storageState, "Kill switch enabled");
        sendLog(message.payload.runId, 0, 0, "error", "Run blocked by kill switch");
        return;
      }
      runWorkflow(message.payload).catch((error) => {
        log("error", "Run failed", error);
        sendStatus(message.payload.runId, "error", storageState, "Run error");
      });
    }
    if (message.type === "CONTROL_PAUSE_RUN") {
      storageState.paused = true;
    }
    if (message.type === "CONTROL_RESUME_RUN") {
      storageState.paused = false;
    }
    if (message.type === "CONTROL_STOP_RUN") {
      storageState.stopped = true;
    }
    if (message.type === "CONTROL_KILL_SWITCH") {
      storageState.killSwitchEnabled = Boolean(message.payload.enabled);
      if (storageState.killSwitchEnabled) {
        storageState.stopped = true;
        storageState.paused = false;
      }
    }
  });

  log("info", "ACP userscript initialized");
})();
