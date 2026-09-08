/**
 * The shape every logged event carries: `{ event, ...ids }`.
 *
 * Shared because R7 makes that shape a promise about *every* event, and the
 * three producers reach the log file by three different routes — main through
 * electron-log directly, the renderer through its IPC transport, the server
 * child through stdout. The routes are deliberately separate; the shape is not,
 * so it lives once.
 */
export function eventPayload(
  event: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  // The name is assigned last so a field can never rename the event — it is
  // what every filter keys on — and appears first in insertion order, so a
  // truncated line still says what happened.
  const payload: Record<string, unknown> = { event, ...fields };
  payload.event = event;
  return payload;
}
