/**
 * High-performance, lightweight HTML to Markdown & Denoise pipeline (Scheme C):
 * - Phase 1 (Denoise & Extract): linkedom (lightweight virtual DOM) + @mozilla/readability (content scoring)
 * - Phase 2 (HTML to Markdown): mdream (Rust/NAPI LLM-optimized converter with @mdream/js fallback)
 *
 * @module dsh-web-fetch-moli/markdown
 */

import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import { htmlToMarkdown as jsHtmlToMarkdown } from '@mdream/js'
import { MAX_PIPELINE_DOM_DEPTH } from './config.ts'

type MdreamConverter = typeof jsHtmlToMarkdown

let activeConverter: MdreamConverter = jsHtmlToMarkdown

// Try loading native mdream (Rust/NAPI) if available in the environment
try {
  const nativeMod = await import('mdream').catch(() => null)
  if (nativeMod && typeof nativeMod.htmlToMarkdown === 'function') {
    // Quick smoke check to ensure native addon binary is actually loadable
    nativeMod.htmlToMarkdown('<span></span>')
    activeConverter = nativeMod.htmlToMarkdown
  }
} catch {
  // Keep using pure JS engine
}

/** Which extraction path produced a result. */
export type DenoiseMode = 'article' | 'document'

/**
 * Element budget above which the pipeline stops handing the tree to Readability.
 *
 * Depth bounds the worst nesting cost, but breadth scales it independently: the
 * same extractor that needs 317ms for a real 182KB / 6.1k-element article takes
 * 1.7s at 12k elements, 5.4s at 40k, and 8.9s at 80k (measured here on flat
 * card-heavy trees, which Readability scores worst). Skipping the scoring phase
 * past this budget keeps the worst case near 1.7s; conversion itself is cheap
 * (mdream turns 48k elements into Markdown in 41ms), so document mode still
 * returns the content.
 */
export const MAX_PIPELINE_DOM_NODES = 12_000

/** One denoise pipeline outcome. */
export interface DenoiseResult {
  /** The markdown body (title, when found, already prepended). */
  markdown: string
  /** `article` = Readability / main extraction; `document` = whole-document fallback. */
  mode: DenoiseMode
  /**
   * True when the pipeline declined full extraction to bound its synchronous
   * runtime: either the tree was deeper than {@link MAX_PIPELINE_DOM_DEPTH} and
   * had its deepest subtrees collapsed, or it held more than
   * {@link MAX_PIPELINE_DOM_NODES} elements and Readability scoring was skipped.
   *
   * Both cases keep the content but give up ad/nav stripping, which a byte
   * count cannot express — the caller should mark its result truncated when
   * this is set.
   */
  pipelineDegraded?: boolean
}

/** Render a byte count as `123B` / `8.9KB` / `1.2MB`. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1_048_576).toFixed(1)}MB`
}

/**
 * Elide inline `data:` payloads to `data:<mime>;base64,...<size>`.
 *
 * The scheme is compared after trimming and lowercasing because a `data:` URI
 * is scheme-case-insensitive and HTML attribute values routinely carry a
 * leading newline from source formatting. Matching the raw value (`startsWith
 * ('data:')`) let `Data:…` and `\n data:…` through untouched, and a single
 * inlined screenshot then consumed the whole output budget.
 * @param src - the raw attribute value.
 * @returns true when this value is an inline `data:` URI.
 */
function isDataUri(value: string): boolean {
  return value.trim().toLowerCase().startsWith('data:')
}

/**
 * Elide inline `data:` payloads to `data:<mime>;base64,...<size>`.
 * @param src - the raw `data:` attribute value.
 * @returns the placeholder that replaces it.
 */
function dataUriPlaceholder(src: string): string {
  const trimmed = src.trim()
  const commaIndex = trimmed.indexOf(',')
  const header = commaIndex === -1 ? trimmed : trimmed.slice(0, commaIndex + 1)
  const payload = commaIndex === -1 ? '' : trimmed.slice(commaIndex + 1).replace(/\s+/g, '')
  const size = /;base64$/i.test(header.slice(5, -1))
    ? Math.max(0, Math.floor(payload.length / 4) * 3 - (payload.match(/=+$/)?.[0].length ?? 0))
    : payload.length
  return `${header}...${humanSize(size)}`
}

/**
 * Attributes that can carry an inline payload into the Markdown.
 *
 * `href` matters as much as `src`: a data-URI download link is inlined by
 * `mdream` verbatim, so a single `<a href="data:application/pdf;base64,…">`
 * put 4.1KB of base64 into the model's context. `srcset`/`poster`/the lazy-load
 * `data-*` mirrors are covered because image pipelines move the payload there
 * before the browser ever sets `src`.
 */
const DATA_URI_ATTRIBUTES = new Set([
  'src',
  'href',
  'poster',
  'srcset',
  'data-src',
  'data-original',
  'data-lazy-src',
])

const CARD_CLASS_RE = /card|item|model/
const AD_CLASS_RE = /(?:^|\s)ad(?:\s|$)/
const CONTENT_CLASS_RE = /(?:^|\s)(?:markdown-body|docs-content)(?:\s|$)|article-content|doc-content/i

/**
 * Tag names that are never content, wherever they sit in the tree: scripts,
 * styles, replaced controls, embeds, script-only fallbacks, and chrome containers.
 */
const ALWAYS_FORBID_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NAV',
  'ASIDE',
  'SVG',
  'IFRAME',
  'NOSCRIPT',
  'BUTTON',
  'SELECT',
  'INPUT',
  'TEXTAREA',
  'DIALOG',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'TEMPLATE',
])

/** Containers whose contents are the page's subject rather than its chrome. */
const CONTENT_CONTAINER_SELECTOR = 'main, [role="main"], article, .markdown-body, .docs-content, [class*="article-content" i], [class*="doc-content" i]'

interface DomPrepStats {
  prunedSubtrees: number
  elementCount: number
  cardLikeCount: number
  hasImg: boolean
}

/**
 * Single explicit-stack DFS over the parsed DOM tree that performs all
 * preprocessing in one traversal without `css-select` full-tree rescans:
 * 1. Strips always-forbidden tags (`<script>`, `<style>`, `<svg>`, `<nav>`,
 *    `<aside>`, form controls, ad/sidebar blocks) before recursing into them;
 * 2. Strips page-level `<header>` / `<footer>` outside content containers
 *    while preserving article-internal title/byline headers and footnotes;
 * 3. Elides inline `data:` URIs across all payload-carrying attributes;
 * 4. Resolves relative `<a href>` and `<img src>` URLs against `baseUrl`;
 * 5. Clamps nesting depth past `maxDepth` to bound Readability's superlinear scoring;
 * 6. Collects surviving element, card-like container, and image counts.
 */
function prepareDomTree(document: Document, baseUrl: string, maxDepth: number): DomPrepStats {
  const root = document.documentElement ?? document.body
  if (!root) {
    return { prunedSubtrees: 0, elementCount: 0, cardLikeCount: 0, hasImg: false }
  }

  let prunedSubtrees = 0
  let elementCount = 0
  let cardLikeCount = 0
  let hasImg = false

  const stack: Array<{ node: Element; depth: number; inContent: boolean }> = [{ node: root, depth: 1, inContent: false }]
  while (stack.length > 0) {
    const entry = stack.pop() as { node: Element; depth: number; inContent: boolean }
    const node = entry.node
    const tag = node.tagName.toUpperCase()

    // 1. Always-forbidden tag check before scanning attributes or children
    if (ALWAYS_FORBID_TAGS.has(tag)) {
      node.remove()
      continue
    }

    let className = ''
    let id = ''
    let role = ''
    const attrs = node.attributes
    if (attrs && attrs.length > 0) {
      for (let i = 0; i < attrs.length; i++) {
        const attr = attrs[i]
        if (!attr) continue
        const attrName = attr.name.toLowerCase()
        if (attrName === 'class') className = attr.value
        else if (attrName === 'id') id = attr.value
        else if (attrName === 'role') role = attr.value
      }
    }

    // 2. Always-forbidden ad/sidebar containers
    if (
      (className !== '' && (AD_CLASS_RE.test(className) || className.includes('banner-ad')))
      || (id !== '' && (id === 'ad' || id.includes('sidebar')))
    ) {
      node.remove()
      continue
    }

    // 3. Content container membership (mirrors closest(CONTENT_CONTAINER_SELECTOR))
    const inContent = entry.inContent
      || tag === 'MAIN'
      || tag === 'ARTICLE'
      || role === 'main'
      || (className !== '' && CONTENT_CLASS_RE.test(className))

    // 4. Page chrome outside any content container
    if (!inContent && (tag === 'HEADER' || tag === 'FOOTER')) {
      node.remove()
      continue
    }

    // Surviving element
    elementCount++
    if (tag === 'IMG') hasImg = true
    if (className !== '' && CARD_CLASS_RE.test(className)) cardLikeCount++

    // 5. Data-URI elision and relative URL resolution on surviving element
    if (attrs && attrs.length > 0) {
      for (let i = 0; i < attrs.length; i++) {
        const attr = attrs[i]
        if (!attr) continue
        const attrName = attr.name.toLowerCase()
        if (!DATA_URI_ATTRIBUTES.has(attrName)) continue
        const value = attr.value
        if (isDataUri(value)) {
          node.setAttribute(attrName, dataUriPlaceholder(value))
          continue
        }
        if (!baseUrl || !value) continue
        if (
          tag === 'A'
          && attrName === 'href'
          && !value.startsWith('http://')
          && !value.startsWith('https://')
          && !value.startsWith('mailto:')
          && !value.startsWith('#')
        ) {
          try { node.setAttribute('href', new URL(value, baseUrl).href) } catch {}
        } else if (
          tag === 'IMG'
          && attrName === 'src'
          && !value.startsWith('http://')
          && !value.startsWith('https://')
        ) {
          try { node.setAttribute('src', new URL(value, baseUrl).href) } catch {}
        }
      }
    }

    // 6. Depth clamp
    if (entry.depth >= maxDepth) {
      if (node.children.length > 0) {
        // Assigning textContent drops every child and keeps the text, in one step.
        node.textContent = node.textContent
        prunedSubtrees++
      }
      continue
    }

    const children = node.children
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (child) stack.push({ node: child, depth: entry.depth + 1, inContent })
    }
  }

  return { prunedSubtrees, elementCount, cardLikeCount, hasImg }
}

/**
 * The matching container holding the most text, or undefined when none match.
 *
 * Picking by document order is what let a top-of-page promo `<article>` stand in
 * for the whole document. Text volume is the cheapest proxy for "this is the
 * page's subject" and needs no layout engine.
 * @param document - the parsed page.
 * @param selector - candidate containers.
 * @returns the container whose trimmed text is longest.
 */
function largestByText(document: Document, selector: string): Element | undefined {
  let best: Element | undefined
  let bestLength = -1
  for (const candidate of Array.from(document.querySelectorAll(selector))) {
    const length = candidate.textContent?.trim().length ?? 0
    if (length > bestLength) {
      best = candidate
      bestLength = length
    }
  }
  return best
}

/**
 * Collapse runs of blank lines in prose while leaving fenced code untouched.
 *
 * A blanket `\n{3,}` → `\n\n` rewrites fenced payload too, and there a blank
 * run is meaning rather than formatting (Python block structure, YAML section
 * separation, unified diffs, log excerpts). The fence marker is tracked with
 * its own character and length so a ```` ```` ```` block containing `~~~` and a
 * longer fence containing a shorter one both stay balanced.
 * @param markdown - converter output.
 * @returns the text with at most one blank line between prose lines.
 */
function collapseProseBlankLines(markdown: string): string {
  const lines = markdown.split('\n')
  const out: string[] = []
  let fence: string | undefined
  let pendingBlanks = 0
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence !== undefined) {
      out.push(line)
      // A closing fence uses the opening character and at least its length.
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      continue
    }
    if (marker !== undefined) {
      if (pendingBlanks > 0 && out.length > 0) out.push('')
      pendingBlanks = 0
      fence = marker
      out.push(line)
      continue
    }
    if (line.trim() === '') {
      pendingBlanks++
      continue
    }
    if (pendingBlanks > 0 && out.length > 0) out.push('')
    pendingBlanks = 0
    out.push(line)
  }
  return out.join('\n')
}

/**
 * Convert rendered HTML document to denoised GitHub Flavored Markdown.
 *
 * @param html - the rendered page HTML.
 * @param url - the page URL, used to resolve relative links.
 * @returns the markdown, the extraction mode used, and whether extraction was degraded.
 */
export function htmlToMarkdown(html: string, url: string): DenoiseResult {
  if (!html || typeof html !== 'string' || !html.trim()) {
    return { markdown: '', mode: 'document' }
  }

  const wrapped = /<html\b/i.test(html) ? html : `<html><body>${html}</body></html>`
  const { document } = parseHTML(wrapped)
  const doc = document as unknown as Document

  let source: string | null = null
  let title = doc.title || ''
  let mode: DenoiseMode = 'article'
  let pipelineDegraded = false

  // 1. Single-pass DOM preparation: strip chrome/scripts/styles, elide data-URIs,
  //    resolve relative URLs, clamp nesting depth, and gather node/card/image counters.
  const { prunedSubtrees, elementCount, cardLikeCount, hasImg } = prepareDomTree(doc, url, MAX_PIPELINE_DOM_DEPTH)
  if (prunedSubtrees > 0) pipelineDegraded = true
  const overNodeBudget = elementCount > MAX_PIPELINE_DOM_NODES
  if (overNodeBudget) pipelineDegraded = true

  const bodyText = doc.body?.textContent?.trim() ?? ''

  // 3. Phase 1: Mozilla Readability scoring
  if (!overNodeBudget && bodyText.length > 0) {
    try {
      const cloned = doc.cloneNode(true) as unknown as Document
      const reader = new Readability(cloned)
      const article = reader.parse()
      if (article && article.content && article.content.trim()) {
        const articleText = article.textContent?.trim() ?? ''

        // Guard against Readability false-positives on catalogs, dashboards, portals, and feeds:
        // Readability is tuned for paragraph-heavy prose articles. When pages are catalogs,
        // portals, or feeds (like news homepages or model markets), Readability frequently
        // latches onto a footer/disclaimer widget and discards the vast majority of the
        // page's content. In such cases, prefer the cleaned document body / main container.
        const isTinyArticleFraction = bodyText.length > 1500 && (
          (articleText.length * 3 < bodyText.length && articleText.length < 1500) ||
          (bodyText.length > 3000 && articleText.length * 2.5 < bodyText.length && articleText.length < 3500)
        )
        const isCardHeavyBody = cardLikeCount >= 5 && articleText.length < 1000

        if (isTinyArticleFraction || isCardHeavyBody) {
          // Discard false positive article, allow fallback to cleaned document body
          source = null
        } else {
          source = article.content
          if (article.title) title = article.title
        }
      }
    } catch {
      // Readability failed on pathological DOM
    }
  }

  // 4. Fallback to main container or whole body if Readability could not extract an article.
  //
  // The container is the LARGEST matching one, not the first in document order:
  // a promo `<article>` near the top of a page (a badge, a carousel slide) is
  // the first `article` in tree order, and taking it silently replaced the whole
  // page with that widget. Selecting by text volume makes an incidental widget
  // lose to the container that actually holds the page.
  if (!source) {
    mode = 'document'
    const container = largestByText(doc, CONTENT_CONTAINER_SELECTOR)
    if (container && (container.textContent?.trim().length ?? 0) > 300) {
      source = container.innerHTML
      mode = 'article'
    } else {
      source = doc.body ? doc.body.innerHTML : ''
    }
  }

  // 5. Phase 2: mdream high-performance LLM-optimized Markdown conversion
  let markdown = activeConverter(source).trim()

  // 6. Collapse prose blank-line runs, leaving fenced code byte-exact
  markdown = collapseProseBlankLines(markdown).trim()

  if (bodyText.length === 0 && !hasImg) {
    mode = 'document'
  }

  // Prepend title when appropriate
  const headingTitle = title.trim()
  if (headingTitle && !markdown.startsWith('# ') && !markdown.startsWith(`# ${headingTitle}`)) {
    markdown = `# ${headingTitle}\n\n${markdown}`
  }

  return pipelineDegraded ? { markdown, mode, pipelineDegraded: true } : { markdown, mode }
}
