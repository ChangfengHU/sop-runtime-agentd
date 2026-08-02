import type { RuntimeEvent } from "./contracts.js";

type EventListener = (event: RuntimeEvent) => void;

export class EventHub {
  private readonly listeners = new Map<string, Set<EventListener>>();

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

  publish(event: RuntimeEvent): void {
    for (const listener of this.listeners.get(event.executionId) ?? []) {
      listener(event);
    }
  }
}
