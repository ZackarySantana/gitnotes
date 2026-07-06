// One-shot renderer for dynamic HTML notes, running under the manifest's
// sandbox CSP (scripts allowed, network blocked, no extension APIs).
//
// The hub posts {type: 'renderHtml', html} into a FRESH iframe pointed at
// sandbox.html; document.write replaces this document wholesale — which also
// destroys this listener. That is by design: the sandbox renders exactly one
// note, and the hub creates a new iframe for every render.
//
// After the rewrite we install a click interceptor on the (reused) Document:
// sandboxed pages can't navigate anywhere themselves, so link clicks are
// forwarded to the hub instead — `gitnotes:diff/...` links drive the hub's
// diff pane, and plain http(s) links get opened in a new tab by the hub.

const GITNOTES_SCHEME = 'gitnotes:'

function interceptLinks(): void {
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[href]')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      const lower = href.toLowerCase()
      if (lower.startsWith(GITNOTES_SCHEME)) {
        event.preventDefault()
        window.parent.postMessage({ type: 'gitnotesLink', href }, '*')
      } else if (lower.startsWith('http:') || lower.startsWith('https:')) {
        event.preventDefault()
        window.parent.postMessage({ type: 'gitnotesExternalLink', href }, '*')
      }
      // Anything else (fragment links etc.): leave to the note's own document.
    },
    true,
  )
}

window.addEventListener('message', (event: MessageEvent) => {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null) return
  const msg = data as { type?: unknown; html?: unknown }
  if (msg.type !== 'renderHtml') return
  if (typeof msg.html !== 'string') return

  document.open()
  document.write(msg.html)
  document.close()
  // document.open() reuses this Document object, so a listener attached now
  // (this script keeps executing) survives on the rewritten note document.
  interceptLinks()
})
