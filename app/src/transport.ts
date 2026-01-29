import {
  ACPMessage,
  AgentAckMessage,
  MESSAGE_CHANNEL,
  validateMessage,
} from "@shared/schema";
import { uuidv4 } from "./utils";

type Listener = (message: ACPMessage) => void;

const STORAGE_KEY = "acp:message";

export class ACPTransport {
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<Listener>();
  private pending = new Map<
    string,
    {
      resolve: (value: AgentAckMessage["payload"]) => void;
      reject: (error: Error) => void;
      retriesLeft: number;
      message: ACPMessage;
      timeoutMs: number;
    }
  >();

  constructor() {
    if ("BroadcastChannel" in window) {
      this.channel = new BroadcastChannel(MESSAGE_CHANNEL);
      this.channel.onmessage = (event) => this.handleIncoming(event.data);
    }
    window.addEventListener("message", (event) => this.handleIncoming(event.data));
    window.addEventListener("storage", (event) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try {
          const payload = JSON.parse(event.newValue);
          this.handleIncoming(payload);
        } catch {
          // ignore
        }
      }
    });
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: ACPMessage) {
    if (this.channel) {
      this.channel.postMessage(message);
      return;
    }
    window.postMessage(message, "*");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
    localStorage.removeItem(STORAGE_KEY);
  }

  sendCommand(message: ACPMessage, timeoutMs = 4000, retries = 2) {
    const requestId = this.extractRequestId(message);
    if (!requestId) {
      return Promise.reject(new Error("Command messages must include a requestId."));
    }
    if (this.pending.size >= 1) {
      return Promise.reject(new Error("Another command is already in flight."));
    }
    return new Promise<AgentAckMessage["payload"]>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, retriesLeft: retries, message, timeoutMs });
      this.dispatchWithRetry(requestId);
    });
  }

  private dispatchWithRetry(requestId: string) {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return;
    }
    this.send(entry.message);
    window.setTimeout(() => {
      const current = this.pending.get(requestId);
      if (!current) {
        return;
      }
      if (current.retriesLeft <= 0) {
        this.pending.delete(requestId);
        current.reject(new Error("No ACK received from agent."));
        return;
      }
      current.retriesLeft -= 1;
      this.dispatchWithRetry(requestId);
    }, entry.timeoutMs);
  }

  createRequestId() {
    return uuidv4();
  }

  private handleIncoming(message: unknown) {
    if (!validateMessage(message)) {
      return;
    }
    if (message.type === "AGENT_ACK") {
      const pending = this.pending.get(message.payload.requestId);
      if (pending) {
        this.pending.delete(message.payload.requestId);
        pending.resolve(message.payload);
      }
    }
    this.listeners.forEach((listener) => listener(message));
  }

  private extractRequestId(message: ACPMessage) {
    if ("payload" in message && typeof message.payload === "object" && message.payload) {
      const payload = message.payload as { requestId?: string };
      return payload.requestId ?? null;
    }
    return null;
  }
}
