export class EventError extends Error {
  constructor(readonly code: number, message: string, readonly data?: Record<string, unknown>) { super(message); }
}
