import { ACPMessage, MESSAGE_CHANNEL, validateMessage } from "@shared/schema";

type Listener = (message: ACPMessage) => void;

const STORAGE_KEY = "acp:message";

export class ACPTransport {
  private channel: BroadcastChannel | null = null;
  private listeners = new Set<Listener>();

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

  private handleIncoming(message: unknown) {
    if (!validateMessage(message)) {
      return;
    }
    this.listeners.forEach((listener) => listener(message));
  }
}
