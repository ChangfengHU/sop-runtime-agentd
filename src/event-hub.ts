import type { RuntimeEvent } from "./contracts.js";

type EventListener = (event: RuntimeEvent) => void;

export class EventHub {
  private readonly listeners = new Map<string, Set<EventListener>>();
  private readonly globalListeners = new Set<EventListener>();

  subscribe(executionId: string, listener: EventListener): () => void {
    const current = this.listeners.get(executionId) ?? new Set<EventListener>();
    current.add(listener);
    this.listeners.set(executionId, current);
    return () => {
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(executionId);
      }
    };
  }

  subscribeAll(listener: EventListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  publish(event: RuntimeEvent): void {
    if (event.executionId) {
      for (const listener of this.listeners.get(event.executionId) ?? []) {
        listener(event);
      }
    }
    for (const listener of this.globalListeners) {
      listener(event);
    }
  }
}
