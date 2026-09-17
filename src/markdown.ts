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

/** One denoise pipeline outcome. */
export interface DenoiseResult {
  /** The markdown body (title, when found, already prepended). */
  markdown: string
  /** `article` = Readability / main extraction; `document` = whole-document fallback. */
  mode: DenoiseMode
}

/** Render a byte count as `123B` / `8.9KB` / `1.2MB`. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1_048_576).toFixed(1)}MB`
}

/**
 * Elide inline `data:` image payloads to `data:<mime>;base64,...<size>`.
 */
function dataUriPlaceholder(src: string): string {
  const commaIndex = src.indexOf(',')
  const header = commaIndex === -1 ? src : src.slice(0, commaIndex + 1)
  const payload = commaIndex === -1 ? '' : src.slice(commaIndex + 1)
  const size = /;base64$/i.test(header.slice(5, -1))
    ? Math.max(0, Math.floor(payload.length / 4) * 3 - (payload.match(/=+$/)?.[0].length ?? 0))
    : payload.length
  return `${header}...${humanSize(size)}`
}

/** Elide data-URI images in the DOM document. */
function elideDataUriImages(document: Document): void {
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = img.getAttribute('src')
    if (src === null || !src.startsWith('data:')) continue
    img.setAttribute('src', dataUriPlaceholder(src))
  }
}

/** Resolve relative links and image sources against baseUrl. */
function resolveRelativeUrls(document: Document, baseUrl: string): void {
  if (!baseUrl) return
  for (const a of Array.from(document.querySelectorAll('a'))) {
    const href = a.getAttribute('href')
    if (href && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('mailto:') && !href.startsWith('#') && !href.startsWith('data:')) {
      try { a.setAttribute('href', new URL(href, baseUrl).href) } catch {}
    }
  }
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = img.getAttribute('src')
    if (src && !src.startsWith('http://') && !src.startsWith('https://') && !src.startsWith('data:')) {
      try { img.setAttribute('src', new URL(src, baseUrl).href) } catch {}
    }
  }
}

const FORBID_SELECTOR = 'nav, aside, header, footer, svg, iframe, noscript, button, select, input, textarea, dialog, canvas, video, audio, template, .ad, #ad, [class*="banner-ad"], [id*="sidebar"]'

/**
 * Convert rendered HTML document to denoised GitHub Flavored Markdown.
 *
 * @param html - the rendered page HTML.
 * @param url - the page URL, used to resolve relative links.
 * @returns the markdown and the extraction mode used.
 */
export function htmlToMarkdown(html: string, url: string): DenoiseResult {
  if (!html || typeof html !== 'string' || !html.trim()) {
    return { markdown: '', mode: 'document' }
  }

  const wrapped = /<html\b/i.test(html) ? html : `<html><body>${html}</body></html>`
  const { document } = parseHTML(wrapped)

  // 1. Elide inline data-URI images early
  elideDataUriImages(document as unknown as Document)

  // 2. Resolve relative URLs
  resolveRelativeUrls(document as unknown as Document, url)

  // 3. Remove layout chrome and interactive noise
  for (const el of Array.from((document as unknown as Document).querySelectorAll(FORBID_SELECTOR))) {
    el.remove()
  }

  let source: string | null = null
  let title = (document as unknown as Document).title || ''
  let mode: DenoiseMode = 'article'

  const doc = document as unknown as Document
  const mainEl = doc.querySelector?.('main, [role="main"], article, .markdown-body, .docs-content, [class*="article-content" i], [class*="doc-content" i]')

  // 4. Phase 1: Mozilla Readability scoring
  try {
    const cloned = doc.cloneNode(true) as unknown as Document
    const reader = new Readability(cloned)
    const article = reader.parse()
    if (article && article.content && article.content.trim()) {
      const targetText = doc.body?.textContent?.trim() ?? ''
      const articleText = article.textContent?.trim() ?? ''

      // Guard against Readability false-positives on catalogs, dashboards, and SPAs:
      // Readability is tuned for paragraph-heavy prose articles. When pages are catalogs,
      // grids, or micro-frontends (like model markets or product lists), Readability frequently
      // latches onto a tiny footer/disclaimer paragraph (< 500 chars) and discards the entire
      // body text (> 1500 chars). In such cases, prefer the cleaned document body / main container.
      const isTinyArticleFraction = targetText.length > 1500 && (articleText.length * 3 < targetText.length) && articleText.length < 1500
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

  // 5. Fallback to main container or whole body if Readability could not extract an article
  if (!source) {
    mode = 'document'
    if (mainEl && (mainEl.textContent?.trim().length ?? 0) > 300) {
      source = mainEl.innerHTML
      mode = 'article'
    } else {
      source = doc.body ? doc.body.innerHTML : ''
    }
  }

  // 6. Phase 2: mdream high-performance LLM-optimized Markdown conversion
  let markdown = activeConverter(source).trim()

  // Collapse runs of blank lines
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim()

  const rawText = (document as unknown as Document).body ? (document as unknown as Document).body.textContent?.trim() ?? '' : ''
  if (rawText.length === 0 && !(document as unknown as Document).querySelector('img')) {
    mode = 'document'
  }

  // Prepend title when appropriate
  const headingTitle = title.trim()
  if (headingTitle && !markdown.startsWith('# ') && !markdown.startsWith(`# ${headingTitle}`)) {
    markdown = `# ${headingTitle}\n\n${markdown}`
  }

  return { markdown, mode }
}
