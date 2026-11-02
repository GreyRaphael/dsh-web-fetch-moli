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
const DATA_URI_ATTRIBUTES = ['src', 'href', 'poster', 'srcset', 'data-src', 'data-original', 'data-lazy-src'] as const

/**
 * Elide inline payloads in every attribute that can reach the Markdown.
 *
 * A mixed `srcset` (prose candidates plus one inlined one) is deliberately
 * left alone: splitting it safely needs a real srcset parser (a `data:` URI may
 * legally contain commas), and the realistic inlining case emits a single
 * `data:` candidate, which this covers.
 * @param document - the parsed page.
 */
function elideDataUris(document: Document): void {
  for (const attribute of DATA_URI_ATTRIBUTES) {
    // `srcset` lives on img/source, `href` on a/link, `poster` on video — the
    // wildcard attribute selector keeps one pass per attribute instead of
    // enumerating element names, which would miss custom lazy-load hosts.
    for (const element of Array.from(document.querySelectorAll(`[${attribute}]`))) {
      const value = element.getAttribute(attribute)
      if (value === null || !isDataUri(value)) continue
      element.setAttribute(attribute, dataUriPlaceholder(value))
    }
  }
}

/**
 * Resolve relative links and image sources against baseUrl.
 *
 * `data:` is recognized through {@link isDataUri} so a scheme-cased or padded
 * inline URI is not handed to `new URL()`, which would re-serialize it and undo
 * the elision the caller just applied.
 */
function resolveRelativeUrls(document: Document, baseUrl: string): void {
  if (!baseUrl) return
  for (const a of Array.from(document.querySelectorAll('a'))) {
    const href = a.getAttribute('href')
    if (href && !isDataUri(href) && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('mailto:') && !href.startsWith('#')) {
      try { a.setAttribute('href', new URL(href, baseUrl).href) } catch {}
    }
  }
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = img.getAttribute('src')
    if (src && !isDataUri(src) && !src.startsWith('http://') && !src.startsWith('https://')) {
      try { img.setAttribute('src', new URL(src, baseUrl).href) } catch {}
    }
  }
}

/**
 * Noise that is never content, wherever it sits in the tree: replaced controls,
 * embeds, script-only fallbacks, and ad/sidebar containers. Removed
 * document-wide, because an ad `<input>` or an `<aside>` inside an article is
 * still an ad or an aside.
 */
const ALWAYS_FORBID_SELECTOR = 'nav, aside, svg, iframe, noscript, button, select, input, textarea, dialog, canvas, video, audio, template, .ad, #ad, [class*="banner-ad"], [id*="sidebar"]'

/**
 * Tags that are site chrome on the page but article structure inside a content
 * container.
 *
 * `<article><header><h1>Title</h1><p>By Alice</p></header>` is the canonical
 * WordPress/Medium/Hugo post layout, and the same holds for the source or
 * footnote `<footer>` a docs theme puts at the end of a post body. Removing
 * these document-wide (the earlier behavior) deleted the article's own heading
 * and byline, and the extractor then substituted the site `<title>` — so the
 * model saw `# Site — Blog` instead of the post title.
 */
const PAGE_CHROME_SELECTOR = 'header, footer'

/** Containers whose contents are the page's subject rather than its chrome. */
const CONTENT_CONTAINER_SELECTOR = 'main, [role="main"], article, .markdown-body, .docs-content, [class*="article-content" i], [class*="doc-content" i]'

/**
 * Remove layout chrome and interactive noise.
 *
 * Page chrome is removed only where it is NOT inside a content container, so a
 * masthead `<header>` (a sibling of `<main>`) goes while an article's title
 * block stays. `closest()` is the membership test: it returns the element
 * itself for a container tag, and null for a node that has no container
 * ancestor at all — a page with no `<main>`/`<article>` keeps the earlier
 * document-wide behavior, since nothing there is identifiable as content.
 * @param document - the parsed page, mutated in place.
 */
function stripChrome(document: Document): void {
  for (const element of Array.from(document.querySelectorAll(ALWAYS_FORBID_SELECTOR))) {
    element.remove()
  }
  for (const element of Array.from(document.querySelectorAll(PAGE_CHROME_SELECTOR))) {
    if (element.closest(CONTENT_CONTAINER_SELECTOR) === null) element.remove()
  }
}

/**
 * Collapse subtrees that nest past `maxDepth` into their own text.
 *
 * Readability's scoring is superlinear in nesting depth and entirely
 * synchronous, so one deep page monopolizes the host event loop: the same 21.6KB
 * document costs 0.47s at 256 deep, 2.0s at 512, and 12.4s at 1024 (measured
 * here; linkedom parsing is 11ms and conversion <1ms of that). Rejecting the
 * page would be simpler but throws away real content, so the tree is flattened
 * instead: at the ceiling each node's `textContent` replaces its children,
 * which keeps the words and removes the depth that made scoring expensive.
 * Measured on a 1024-deep document this cuts 1029 elements to 130 and scoring
 * from 12.4s to 193ms; a 20-deep page is untouched (0 nodes pruned).
 *
 * The walk is an explicit-stack DFS rather than recursion: the documents this
 * exists for are exactly the ones that would overflow the JS call stack.
 * @param document - the parsed page, mutated in place.
 * @param maxDepth - deepest allowed ancestor chain, counting the root as 1.
 * @returns the number of subtrees that were collapsed.
 */
function clampDepth(document: Document, maxDepth: number): number {
  const root = document.documentElement ?? document.body
  if (!root) return 0
  let pruned = 0
  const stack: Array<{ node: Element; depth: number }> = [{ node: root, depth: 1 }]
  while (stack.length > 0) {
    const entry = stack.pop() as { node: Element; depth: number }
    if (entry.depth >= maxDepth) {
      if (entry.node.children.length > 0) {
        // Assigning textContent drops every child and keeps the text, in one step.
        entry.node.textContent = entry.node.textContent
        pruned++
      }
      continue
    }
    for (const child of Array.from(entry.node.children)) {
      stack.push({ node: child, depth: entry.depth + 1 })
    }
  }
  return pruned
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

  // 1. Elide inline data-URI payloads early, before any step can copy them
  elideDataUris(document as unknown as Document)

  // 2. Resolve relative URLs
  resolveRelativeUrls(document as unknown as Document, url)

  // 3. Remove layout chrome and interactive noise, keeping article structure
  stripChrome(document as unknown as Document)

  let source: string | null = null
  let title = (document as unknown as Document).title || ''
  let mode: DenoiseMode = 'article'
  let pipelineDegraded = false

  const doc = document as unknown as Document

  // 3b. Bound the tree before the synchronous scoring phase sees it.
  //
  // Depth is clamped first (cheap, and it is the axis that makes scoring
  // superlinear), then the element count decides whether scoring runs at all.
  // Both are recorded as `pipelineDegraded`, because either one means the
  // caller gets real content without the ad/nav stripping a normal run does.
  const prunedSubtrees = clampDepth(doc, MAX_PIPELINE_DOM_DEPTH)
  const elementCount = doc.querySelectorAll('*').length
  if (prunedSubtrees > 0) pipelineDegraded = true
  const overNodeBudget = elementCount > MAX_PIPELINE_DOM_NODES
  if (overNodeBudget) pipelineDegraded = true

  // 4. Phase 1: Mozilla Readability scoring
  if (!overNodeBudget) {
    try {
      const cloned = doc.cloneNode(true) as unknown as Document
      const reader = new Readability(cloned)
      const article = reader.parse()
      if (article && article.content && article.content.trim()) {
        const targetText = doc.body?.textContent?.trim() ?? ''
        const articleText = article.textContent?.trim() ?? ''

        // Guard against Readability false-positives on catalogs, dashboards, portals, and feeds:
        // Readability is tuned for paragraph-heavy prose articles. When pages are catalogs,
        // portals, or feeds (like news homepages or model markets), Readability frequently
        // latches onto a footer/disclaimer widget and discards the vast majority of the
        // page's content. In such cases, prefer the cleaned document body / main container.
        const isTinyArticleFraction = targetText.length > 1500 && (
          (articleText.length * 3 < targetText.length && articleText.length < 1500) ||
          (targetText.length > 3000 && articleText.length * 2.5 < targetText.length && articleText.length < 3500)
        )
        const isCardHeavyBody = (doc.querySelectorAll?.('[class*="card"], [class*="item"], [class*="model"]').length ?? 0) >= 5 && articleText.length < 1000

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

  // 5. Fallback to main container or whole body if Readability could not extract an article.
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

  // 6. Phase 2: mdream high-performance LLM-optimized Markdown conversion
  let markdown = activeConverter(source).trim()

  // 7. Collapse prose blank-line runs, leaving fenced code byte-exact
  markdown = collapseProseBlankLines(markdown).trim()

  const rawText = (document as unknown as Document).body ? (document as unknown as Document).body.textContent?.trim() ?? '' : ''
  if (rawText.length === 0 && !(document as unknown as Document).querySelector('img')) {
    mode = 'document'
  }

  // Prepend title when appropriate
  const headingTitle = title.trim()
  if (headingTitle && !markdown.startsWith('# ') && !markdown.startsWith(`# ${headingTitle}`)) {
    markdown = `# ${headingTitle}\n\n${markdown}`
  }

  return pipelineDegraded ? { markdown, mode, pipelineDegraded: true } : { markdown, mode }
}
