/**
 * @dsh-external/dsh-mermaid — host half.
 *
 * The whole feature is browser-side: the client half observes the transcript and
 * replaces `mermaid` code blocks with diagrams. The host contributes nothing but
 * the profile entry and the `/plugins` route that serves this package's own
 * `lib/client.js` and the vendored `lib/client.mermaid.js` chunk, so this half
 * is intentionally empty.
 */

export const name = 'dsh-mermaid'

/** No host-side behaviour. */
export function apply() {}
