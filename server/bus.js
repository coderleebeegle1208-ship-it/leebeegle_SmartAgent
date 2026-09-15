// In-process event bus. Server broadcasts every event to WebSocket clients.
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(type, payload) {
  bus.emit('event', { type, ...payload, ts: Date.now() });
}
