import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { GITNOTES_LINK_SCHEME } from './types'
import type { NoteResult, RenderContext } from './types'

/**
 * Render a note's body to a detached element the caller inserts. Dispatches on
 * the parsed type through the renderer registry: html -> title + "Open dynamic
 * note" chip (never renders note HTML inline), markdown -> sanitized render,
 * text/unknown -> autolinked <pre>.
 *
 * No chrome.* APIs here — this module is shared by the content script and the
 * Hub.
 */

type Renderer = (body: string, note: NoteResult, ctx: RenderContext) => HTMLElement

const URL_RE = /(https?:\/\/[^\s<>"'`]+)/g

/** Plain text: <pre> with autolinked URLs, built from DOM nodes (no innerHTML). */
function renderText(body: string): HTMLElement {
  const pre = document.createElement('pre')
  pre.className = 'gitnotes-text'
  for (const part of body.split(URL_RE)) {
    if (part === '') continue
    if (/^https?:\/\//.test(part)) {
      const a = document.createElement('a')
      a.href = part
      a.textContent = part
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      pre.appendChild(a)
    } else {
      pre.appendChild(document.createTextNode(part))
    }
  }
  return pre
}

/** Markdown: marked -> DOMPurify (conservative profile) -> innerHTML of the
 * sanitized string only. */
function renderMarkdown(body: string, ctx: RenderContext): HTMLElement {
  const html = marked.parse(body, { async: false })
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
    ALLOW_DATA_ATTR: false,
    // Default schemes plus gitnotes: for diff-aware links.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|gitnotes:)/i,
  })
  const div = document.createElement('div')
  div.className = 'gitnotes-markdown'
  div.innerHTML = clean
  for (const a of div.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    if (href.toLowerCase().startsWith(GITNOTES_LINK_SCHEME)) {
      // Diff-aware link: never navigates; handled by the surface.
      a.classList.add('gitnotes-diff-link')
      const onDiffLink = ctx.onDiffLink
      a.addEventListener('click', (event) => {
        event.preventDefault()
        if (onDiffLink) onDiffLink(href)
      })
    } else {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
  }
  return div
}

/** HTML: never rendered inline — security invariant. Title + Hub chip only. */
function renderHtmlTeaser(_body: string, note: NoteResult, ctx: RenderContext): HTMLElement {
  const div = document.createElement('div')
  div.className = 'gitnotes-html-teaser'

  const strong = document.createElement('strong')
  strong.textContent =
    (note.parsed.kind === 'typed' && note.parsed.envelope.title) || 'Dynamic note'
  div.appendChild(strong)

  const hint = document.createElement('div')
  hint.className = 'gitnotes-muted'
  hint.textContent = 'This is a dynamic HTML note — it opens in the GitNotes Hub.'
  div.appendChild(hint)

  const chip = document.createElement('button')
  chip.className = 'gitnotes-chip'
  chip.type = 'button'
  chip.textContent = 'Open dynamic note ⧉'
  const onOpenHub = ctx.onOpenHub
  if (onOpenHub) {
    chip.addEventListener('click', () => onOpenHub(note))
  } else {
    chip.disabled = true
    chip.title = 'The Hub ships in the next version'
  }
  div.appendChild(chip)

  return div
}

const renderers: Record<string, Renderer> = {
  text: (body) => renderText(body),
  markdown: (body, _note, ctx) => renderMarkdown(body, ctx),
  html: renderHtmlTeaser,
}

/** Unknown type on a valid envelope: raw body as text plus a schema hint. */
function renderUnknown(type: string, body: string): HTMLElement {
  const div = document.createElement('div')
  div.appendChild(renderText(body))
  const hint = document.createElement('div')
  hint.className = 'gitnotes-muted'
  hint.textContent = `Note type '${type}' comes from a newer GitNotes schema — showing raw content.`
  div.appendChild(hint)
  return div
}

export function renderNote(note: NoteResult, ctx: RenderContext): HTMLElement {
  if (note.parsed.kind === 'text') {
    return renderText(note.parsed.content)
  }
  const { type, body } = note.parsed.envelope
  const renderer = renderers[type]
  if (!renderer) return renderUnknown(type, body)
  return renderer(body, note, ctx)
}
