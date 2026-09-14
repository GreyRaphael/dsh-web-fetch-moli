/**
 * Ultra-lightweight, pure TypeScript HTML to Markdown & Denoise pipeline.
 *
 * Replaces heavy dependencies (jsdom, @mozilla/readability, dompurify,
 * turndown, @joplin/turndown-plugin-gfm) with a high-performance,
 * zero-dependency synchronous cleaner and converter.
 *
 * @module dsh-web-fetch-moli/markdown
 */

/** Which extraction path produced a result. */
export type DenoiseMode = 'article' | 'document'

/** One denoise pipeline outcome. */
export interface DenoiseResult {
  /** The markdown body (title, when found, already prepended). */
  markdown: string
  /** `article` = meaningful article/main extraction; `document` = whole-document fallback. */
  mode: DenoiseMode
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

/** Render a byte count as `123B` / `8.9KB` / `1.2MB`. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1_048_576).toFixed(1)}MB`
}

/** Decode common HTML entities. */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * Convert rendered HTML document to denoised GitHub Flavored Markdown.
 *
 * @param html - the rendered page HTML.
 * @param url - the page URL, used to resolve relative links.
 * @returns the markdown and the extraction mode used.
 */
export function htmlToMarkdown(html: string, url: string): DenoiseResult {
  if (!html || typeof html !== 'string') {
    return { markdown: '', mode: 'document' }
  }

  // 1. Extract title before stripping tags
  let pageTitle = ''
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch && titleMatch[1]) {
    pageTitle = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim()
  }

  // 2. Remove comments and non-content tags
  let text = html.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
  text = text.replace(/<(script|style|noscript|svg|iframe|canvas|dialog|video|audio|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')

  // 3. Elide data-URI images early
  text = text.replace(/<img\b([^>]*?)src=["'](data:[^"']+)["']([^>]*?)>/gi, (_match, before: string, src: string, after: string) => {
    const placeholder = dataUriPlaceholder(src)
    return `<img${before}src="${placeholder}"${after}>`
  })

  // 4. Strip layout chrome (nav, aside, footer, header, ads)
  text = text.replace(/<(nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<([a-z0-9]+)\b[^>]*(class|id)=["'][^"']*\b(ad|banner-ad|advertisement|sponsor|sidebar)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, '')

  // 5. Strip interactive form controls (button, select, input, textarea)
  text = text.replace(/<(button|select|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<input\b[^>]*\/?>/gi, '')

  // 6. Region extraction: article > main > body
  let mode: DenoiseMode = 'article'
  let contentHtml = text
  const articleMatch = text.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
  const mainMatch = text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)

  const bodyContent = text.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? text
  const bodyText = bodyContent.replace(/<[^>]+>/g, '').trim()

  const articleText = articleMatch?.[1]
  const mainText = mainMatch?.[1]

  if (articleText && articleText.replace(/<[^>]+>/g, '').trim().length > 0) {
    contentHtml = articleText
  } else if (mainText && mainText.replace(/<[^>]+>/g, '').trim().length > 0) {
    contentHtml = mainText
  } else {
    contentHtml = bodyContent
    if (bodyText.length === 0 || (!articleMatch && !mainMatch && !/<img\b/i.test(bodyContent) && bodyText.length < 50)) {
      mode = 'document'
    }
  }

  // 7. Convert HTML elements to Markdown
  // Tables
  contentHtml = contentHtml.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_match, tableInner: string) => {
    const rows: string[][] = []
    const trRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    let trMatch: RegExpExecArray | null
    while ((trMatch = trRegex.exec(tableInner)) !== null) {
      const trContent = trMatch[1]
      if (!trContent) continue
      const cells: string[] = []
      const cellRegex = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi
      let cellMatch: RegExpExecArray | null
      while ((cellMatch = cellRegex.exec(trContent)) !== null) {
        const cellText = cellMatch[2] ?? ''
        cells.push(decodeHtmlEntities(cellText.replace(/<[^>]+>/g, '')).trim())
      }
      if (cells.length > 0) rows.push(cells)
    }

    const firstRow = rows[0]
    if (!firstRow || rows.length === 0) return ''

    let tableMd = '\n\n'
    tableMd += '| ' + firstRow.join(' | ') + ' |\n'
    tableMd += '| ' + firstRow.map(() => '---').join(' | ') + ' |\n'
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]
      if (row) {
        tableMd += '| ' + row.join(' | ') + ' |\n'
      }
    }
    return tableMd + '\n'
  })

  // Images
  contentHtml = contentHtml.replace(/<img\b([^>]*?)\/?>/gi, (_match, attrs: string) => {
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i)
    const altMatch = attrs.match(/\balt=["']([^"']*)["']/i)
    const titleMatch = attrs.match(/\btitle=["']([^"']*)["']/i)
    if (!srcMatch || !srcMatch[1]) return ''
    let src = srcMatch[1]
    if (url && !src.startsWith('data:') && !src.startsWith('http://') && !src.startsWith('https://')) {
      try { src = new URL(src, url).href } catch {}
    }
    const alt = altMatch?.[1] ?? ''
    const title = titleMatch?.[1] ? ` "${titleMatch[1]}"` : ''
    return `![${alt}](${src}${title})`
  })

  // Links
  contentHtml = contentHtml.replace(/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, aContent: string) => {
    let resolved = href
    if (url && href && !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('mailto:') && !href.startsWith('#') && !href.startsWith('data:')) {
      try { resolved = new URL(href, url).href } catch {}
    }
    const linkText = decodeHtmlEntities(aContent.replace(/<[^>]+>/g, '')).trim()
    return linkText ? `[${linkText}](${resolved})` : ''
  })

  // Headings: if pageTitle is present, demote h1..h5 by 1 to make pageTitle the # header
  const shift = pageTitle ? 1 : 0
  contentHtml = contentHtml.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level: string, hText: string) => {
    const clean = decodeHtmlEntities(hText.replace(/<[^>]+>/g, '')).trim()
    const targetLevel = Math.min(6, Number(level) + shift)
    return clean ? `\n\n${'#'.repeat(targetLevel)} ${clean}\n\n` : ''
  })

  // Code blocks & inline code
  contentHtml = contentHtml.replace(/<pre\b[^>]*><code\b[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_match, code: string) => {
    return `\n\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n\n`
  })
  contentHtml = contentHtml.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, code: string) => {
    return `\`${decodeHtmlEntities(code).trim()}\``
  })

  // Lists
  contentHtml = contentHtml.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, item: string) => {
    const clean = decodeHtmlEntities(item.replace(/<[^>]+>/g, '')).trim()
    return clean ? `\n- ${clean}` : ''
  })
  contentHtml = contentHtml.replace(/<\/(ul|ol)>/gi, '\n\n')

  // Blockquotes
  contentHtml = contentHtml.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, bq: string) => {
    const clean = decodeHtmlEntities(bq.replace(/<[^>]+>/g, '')).trim()
    return clean ? `\n\n> ${clean}\n\n` : ''
  })

  // Paragraphs & Divs & Breaks
  contentHtml = contentHtml.replace(/<br\s*\/?>/gi, '\n')
  contentHtml = contentHtml.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_match, p: string) => `\n\n${p}\n\n`)
  contentHtml = contentHtml.replace(/<div\b[^>]*>([\s\S]*?)<\/div>/gi, (_match, d: string) => `\n${d}\n`)

  // Bold, Italic & Strikethrough
  contentHtml = contentHtml.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, inner: string) => `**${inner}**`)
  contentHtml = contentHtml.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, inner: string) => `*${inner}*`)
  contentHtml = contentHtml.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag: string, inner: string) => `~~${inner}~~`)

  // Strip remaining HTML tags
  let markdown = contentHtml.replace(/<[^>]+>/g, '')
  markdown = decodeHtmlEntities(markdown)

  // Normalize whitespace
  markdown = markdown
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (bodyText.length === 0 && !/<img\b/i.test(bodyContent)) {
    mode = 'document'
  }

  // Prepend title
  if (pageTitle && !markdown.startsWith('# ' + pageTitle)) {
    markdown = `# ${pageTitle}\n\n${markdown}`
  }

  return { markdown, mode }
}
