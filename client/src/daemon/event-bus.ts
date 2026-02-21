export type Listener<T> = (event: T) => void;
export type Unsubscribe = () => void;

export class EventBus<T> {
  private listeners = new Set<Listener<T>>();

  subscribe(listener: Listener<T>): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: T): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}
