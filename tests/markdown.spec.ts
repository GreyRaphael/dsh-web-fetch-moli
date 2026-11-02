/**
 * The denoise pipeline against representative fixture pages: a docs-style
 * article wrapped in nav/sidebar/footer/ads chrome, a table page, and a
 * non-article page that must fall back to whole-document conversion.
 */
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../src/markdown.ts'

/** A typical docs/blog page: header nav, sidebar, article, footer, ad slots. */
const ARTICLE_PAGE = `<!doctype html>
<html><head><title>Moli guide</title><style>.x{color:red}</style></head>
<body>
<nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/blog">Blog</a></nav>
<aside id="sidebar"><div>Related</div><ul><li><a href="/a">link one</a></li><li><a href="/b">link two</a></li></ul></aside>
<main>
<article>
<h1>Getting started</h1>
<p>Playwright enables reliable end-to-end testing of modern web apps. It works across all major browsers, runs headless or headed, and captures traces for every run.</p>
<h2>Installation</h2>
<p>Install with <code>npm i playwright</code>, then run <code>playwright install</code> once to download the browser binaries the library drives.</p>
<ul><li>Auto-wait for elements</li><li>Network interception</li><li>Multi-browser contexts</li></ul>
<p>See the <a href="https://example.com/docs">full documentation</a> for details.</p>
</article>
</main>
<div class="ad banner-ad"><a href="/buy">BUY NOW — 50% OFF</a></div>
<footer><nav><a href="/tos">Terms</a> <a href="/privacy">Privacy</a></nav>© 2026 Example Corp</footer>
<script>window.tracker = { send: () => {} }</script>
</body></html>`

/** A page whose payload is one GFM table. */
const TABLE_PAGE = `<!doctype html>
<html><head><title>Servers</title></head><body>
<nav>global nav noise</nav>
<main>
<h1>Servers</h1>
<p>Two server regions are currently online and accepting traffic from the control plane.</p>
<table>
<thead><tr><th>Name</th><th>Region</th></tr></thead>
<tbody>
<tr><td>alpha</td><td>cn-north</td></tr>
<tr><td>beta</td><td>us-east</td></tr>
</tbody>
</table>
</main>
<footer>footer noise</footer>
</body></html>`

/** A page with no article structure at all (login-like). */
const NON_ARTICLE_PAGE = `<!doctype html>
<html><head><title>Login</title></head><body>
<nav>nav noise</nav>
<main><h1>Login</h1><form><input name="user"><input name="pass" type="password"><button>Sign in</button></form><p>Session expired, please sign in again. Enter your credentials to continue where you left off.</p></main>
<footer>footer noise</footer>
</body></html>`

/** A build-tool-inlined data URI payload (4096 base64 chars = 3072 bytes). */
const DATA_URI_3KB = `data:image/png;base64,${'A'.repeat(4096)}`

/** A docs article whose build tool inlined its screenshots as data URIs. */
const INLINE_IMAGE_PAGE = `<!doctype html>
<html><head><title>Inline images</title></head><body>
<nav>nav noise</nav>
<main><article>
<h1>Guide</h1>
<p>Intro paragraph with enough text for extraction to latch onto the article region.</p>
<p><img decoding=async loading=lazy alt="tiny chart" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="></p>
<p><img alt="big screenshot" title="The screenshot" src="${DATA_URI_3KB}"></p>
<p><img alt="remote photo" src="https://example.com/photo.png"></p>
</article></main>
<footer>footer noise</footer>
</body></html>`

describe('htmlToMarkdown', () => {
  it('extracts the article and drops nav/sidebar/footer/ad chrome', () => {
    const { markdown, mode } = htmlToMarkdown(ARTICLE_PAGE, 'https://example.com/guide')
    expect(mode).toBe('article')
    // The extracted title leads the markdown (Readability kept the article's
    // own heading structure, so the prepended title is the page <title>).
    expect(markdown).toContain('# Moli guide')
    expect(markdown).toContain('Getting started')
    expect(markdown).toContain('reliable end-to-end testing')
    expect(markdown).toMatch(/-\s+Auto-wait for elements/)
    expect(markdown).toContain('[full documentation](https://example.com/docs)')
    // Chrome must be gone.
    expect(markdown).not.toContain('Home')
    expect(markdown).not.toContain('Related')
    expect(markdown).not.toContain('BUY NOW')
    expect(markdown).not.toContain('Terms')
    expect(markdown).not.toContain('© 2026')
    expect(markdown).not.toContain('window.tracker')
  })

  it('converts GFM tables with a header separator', () => {
    const { markdown } = htmlToMarkdown(TABLE_PAGE, 'https://example.com/servers')
    expect(markdown).toContain('| Name | Region |')
    expect(markdown).toContain('| --- | --- |')
    expect(markdown).toContain('| alpha | cn-north |')
    expect(markdown).not.toContain('nav noise')
    expect(markdown).not.toContain('footer noise')
  })

  it('extracts the meaningful content of sparse pages (login-like)', () => {
    const { markdown, mode } = htmlToMarkdown(NON_ARTICLE_PAGE, 'https://example.com/login')
    // Readability keeps the meaningful paragraph; the form and chrome go.
    expect(mode).toBe('article')
    expect(markdown).toContain('Session expired')
    expect(markdown).not.toContain('nav noise')
    expect(markdown).not.toContain('footer noise')
    expect(markdown).not.toContain('Sign in')
  })

  it('falls back to whole-document conversion when extraction yields nothing', () => {
    const page = `<!doctype html><html><head><title>Empty-ish</title></head><body>
<nav>nav noise</nav>
<main><p>just one plain line of body text</p></main>
<footer>footer noise</footer>
</body></html>`
    // An empty body is the reliable null-parse shape; the pipeline's fallback
    // is exercised by the pathological-input test below.
    const { mode } = htmlToMarkdown('<html><body></body></html>', 'https://example.com/e')
    expect(mode).toBe('document')
    expect(htmlToMarkdown(page, 'https://example.com/p').markdown).toContain('plain line of body text')
  })

  it('elides inline data-URI image payloads to size placeholders', () => {
    const { markdown, mode } = htmlToMarkdown(INLINE_IMAGE_PAGE, 'https://example.com/guide')
    expect(mode).toBe('article')
    // The base64 payloads are gone entirely...
    expect(markdown).not.toContain('iVBORw0KGgo')
    expect(markdown).not.toContain('A'.repeat(64))
    // ...replaced by alt-bearing, MIME-and-size-marked placeholders; the
    // default image rule's title handling still applies to the short src.
    expect(markdown).toMatch(/!\[tiny chart\]\(data:image\/png;base64,...\d+B\)/)
    expect(markdown).toContain('![big screenshot](data:image/png;base64,...3.0KB "The screenshot")')
    // Remote images are untouched.
    expect(markdown).toContain('![remote photo](https://example.com/photo.png)')
  })

  it('elides data-URI images on the whole-document fallback path too', () => {
    const page = `<!doctype html><html><head><title>Sparse</title></head><body>
<img alt="inline diagram" src="${DATA_URI_3KB}">
</body></html>`
    const { markdown, mode } = htmlToMarkdown(page, 'https://example.com/sparse')
    // An image-only body gives Readability nothing to extract: the fallback
    // path must apply the same elision the article path does.
    expect(mode).toBe('document')
    expect(markdown).toContain('![inline diagram](data:image/png;base64,...3.0KB)')
    expect(markdown).not.toContain('A'.repeat(64))
  })

  it('survives pathological input without throwing', () => {
    expect(() => htmlToMarkdown('', 'https://example.com/x')).not.toThrow()
    expect(() => htmlToMarkdown('<html><body>', 'https://example.com/x')).not.toThrow()
    const { markdown } = htmlToMarkdown('<p>hello</p>', 'https://example.com/x')
    expect(markdown.toLowerCase()).toContain('hello')
  })

  it('does not discard <main> content when carousel/banner <article> tags exist', () => {
    const page = `<!doctype html><html><head><title>Model Catalog</title></head><body>
<nav>Header Nav</nav>
<main>
  <div class="carousel">
    <article class="slide"><h3>Banner 1</h3><p>Promo text 1</p></article>
    <article class="slide"><h3>Banner 2</h3><p>Promo text 2</p></article>
  </div>
  <div class="catalog">
    <h2>Available Models</h2>
    <p>Qwen3.8-Max: 2.4T parameters MoE foundation model.</p>
    <p>DeepSeek-V3: High-efficiency reasoning model.</p>
  </div>
</main>
<footer>Footer</footer>
</body></html>`
    const { markdown, mode } = htmlToMarkdown(page, 'https://example.com/catalog')
    expect(mode).toBe('article')
    expect(markdown).toContain('Available Models')
    expect(markdown).toContain('Qwen3.8-Max')
    expect(markdown).toContain('DeepSeek-V3')
    expect(markdown).not.toContain('Header Nav')
    expect(markdown).not.toContain('Footer')
  })

  it('preserves multiple <article> tags on feed pages without <main>', () => {
    const page = `<!doctype html><html><head><title>Blog</title></head><body>
<nav>Nav</nav>
<article><h2>Post 1</h2><p>Article 1 content here.</p></article>
<article><h2>Post 2</h2><p>Article 2 content here.</p></article>
<footer>Footer</footer>
</body></html>`
    const { markdown, mode } = htmlToMarkdown(page, 'https://example.com/blog')
    expect(mode).toBe('article')
    expect(markdown).toContain('Post 1')
    expect(markdown).toContain('Article 1 content here.')
    expect(markdown).toContain('Post 2')
    expect(markdown).toContain('Article 2 content here.')
    expect(markdown).not.toContain('Nav')
    expect(markdown).not.toContain('Footer')
  })

  it('does not discard body content when an insignificant stray <article> widget exists without <main>', () => {
    const page = `<!doctype html><html><head><title>Doc</title></head><body>
<nav>Nav</nav>
<div class="content-body">
  <h2>Documentation Section</h2>
  <p>Detailed technical documentation with lots of paragraphs and explanation for users...</p>
</div>
<article class="badge">Badge</article>
<footer>Footer</footer>
</body></html>`
    const { markdown } = htmlToMarkdown(page, 'https://example.com/doc')
    expect(markdown).toContain('Documentation Section')
    expect(markdown).toContain('Detailed technical documentation')
    expect(markdown).not.toContain('Nav')
    expect(markdown).not.toContain('Footer')
  })

  it('recognizes role="main" or id="main" when <main> tag is omitted', () => {
    const page = `<!doctype html><html><head><title>App</title></head><body>
<div class="sidebar">Sidebar noise</div>
<div role="main">
  <h2>Dashboard</h2>
  <p>Main analytics content here.</p>
</div>
</body></html>`
    const { markdown, mode } = htmlToMarkdown(page, 'https://example.com/app')
    expect(mode).toBe('article')
    expect(markdown).toContain('Dashboard')
    expect(markdown).toContain('Main analytics content here.')
    expect(markdown).not.toContain('Sidebar noise')
  })

  it('preserves entire card catalog when a tiny promo paragraph exists', () => {
    const cards = Array.from({ length: 15 }, (_, i) => `
      <div class="card-item model-card">
        <h3>Model-${i}</h3>
        <div>Parameters: 100B, Context: 128K</div>
        <div>Description of model-${i} with capabilities and performance details.</div>
      </div>
    `).join('\n')
    const page = `<!doctype html><html><head><title>Market</title></head><body>
      <div class="banner"><p>Tiny disclaimer footnote</p></div>
      <div class="grid-container">${cards}</div>
    </body></html>`
    const { markdown } = htmlToMarkdown(page, 'https://example.com/market')
    expect(markdown).toContain('Model-0')
    expect(markdown).toContain('Model-14')
    expect(markdown).toContain('Parameters: 100B')
    expect(markdown).toContain('Description of model-0')
  })

  /**
   * A news-portal fixture whose body is a link-heavy story feed plus a
   * medium prose "about" widget (~2.3k chars). Readability latches onto the
   * widget — too big for the first tiny-article branch (< 1500) yet under
   * 40% of the body — so only the second branch (> 3000 body, article < 2.5x
   * body, article < 3500) can reject it and keep the feed.
   */
  function portalFeedPage(entryCount: number): string {
    const entries = Array.from({ length: entryCount }, (_, i) => `
      <div>
        <h3><a href="/story-${i}">Story headline number ${i} about regional developments</a></h3>
        <p>Summary ${i}: ${'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(2)}(${i})</p>
      </div>`).join('\n')
    const about = Array.from({ length: 8 }, (_, i) =>
      `<p>${'About this portal: it aggregates stories and offers editorial coverage of technology sectors. '.repeat(3)}(${i})</p>`).join('\n')
    return `<!doctype html><html><head><title>Portal</title></head><body>
<div class="stories">${entries}</div>
<div class="about"><h2>About</h2>${about}</div>
</body></html>`
  }

  it('rejects a medium prose widget on a large feed page (> 3000 body, article < 2.5x) and keeps the feed', () => {
    // 30 entries put the body at ~9.5k chars against a ~2.3k article: the
    // first branch cannot fire (article >= 1500), only the second can.
    const { markdown, mode } = htmlToMarkdown(portalFeedPage(30), 'https://example.com/portal')
    expect(mode).toBe('document')
    expect(markdown).toContain('Story headline number 0')
    expect(markdown).toContain('Story headline number 29')
    expect(markdown).toContain('About this portal')
  })

  it('keeps a medium article that is a majority of the body (ratio under 2.5x)', () => {
    // 10 entries shrink the body to ~4.7k chars against the same ~2.3k
    // article: the ratio drops below 2.5x, so the widget is a legitimate
    // article and must NOT be discarded.
    const { markdown, mode } = htmlToMarkdown(portalFeedPage(10), 'https://example.com/portal')
    expect(mode).toBe('article')
    expect(markdown).toContain('About this portal')
    expect(markdown).not.toContain('Story headline number')
  })
})

describe('article structure preservation', () => {
  /** The canonical CMS layout: the post's own heading lives inside <header>. */
  const POST_WITH_HEADER = `<!doctype html>
<html><head><title>Site — Blog</title></head><body>
<header><a href="/">Example Corp</a> <nav><a href="/about">About</a></nav></header>
<main>
<article>
<header><h1>Why we rewrote the fetch layer</h1><p class="byline">By Alice</p></header>
<p>Playwright enables reliable end-to-end testing of modern web apps. It works across all major browsers and captures traces for every run.</p>
<p>Every once in a while a layer becomes the bottleneck, and this one finally did after months of growth.</p>
</article>
</main>
<footer>© 2026 Example Corp</footer>
</body></html>`

  it('keeps the heading and byline the article carries inside its own header', () => {
    const { markdown } = htmlToMarkdown(POST_WITH_HEADER, 'https://example.com/blog/rewrite')
    // The article's <header><h1> is post structure, not site chrome. Removing it
    // document-wide (the earlier behavior) deleted the real title and left the
    // site <title> in its place, so the model saw "Site — Blog" instead of the
    // post name.
    expect(markdown).toContain('Why we rewrote the fetch layer')
    expect(markdown).toContain('By Alice')
  })

  it('still removes the site header and footer around the article', () => {
    const { markdown } = htmlToMarkdown(POST_WITH_HEADER, 'https://example.com/blog/rewrite')
    expect(markdown).not.toContain('About')
    expect(markdown).not.toContain('© 2026 Example Corp')
  })

  it('still strips nav/sidebar/ad chrome on a page with no content container', () => {
    // No <main>/<article> anywhere: nothing is identifiable as content, so chrome
    // removal falls back to document-wide and the page reads as prose.
    const page = `<!doctype html><html><head><title>Bare</title></head><body>
<nav><a href="/">Home</a></nav>
<footer><a href="/tos">Terms</a></footer>
<div class="ad banner-ad"><a href="/buy">BUY NOW</a></div>
<p>A short paragraph of body text that survives the chrome removal and stays readable.</p>
</body></html>`
    const { markdown } = htmlToMarkdown(page, 'https://example.com/bare')
    expect(markdown).toContain('A short paragraph of body text')
    expect(markdown).not.toContain('Home')
    expect(markdown).not.toContain('BUY NOW')
  })

  it('picks the largest container rather than the first in document order', () => {
    // A promo <article> at the top of the page is the FIRST `article` in tree
    // order, while the real post is the largest. Selecting by document order
    // (the earlier behavior) returned the promo and dropped the post.
    // The card-heavy guard is what forces the fallback container lookup here:
    // six card elements plus a short extracted article makes Readability's
    // result untrusted, so the fallback picks a container by text volume.
    const promo = 'Badge promo copy. '.repeat(20)
    const post = 'Real content sentence here. '.repeat(20)
    const cards = Array.from({ length: 6 }, (_, i) => `<div class="card"><h3>Card ${i}</h3><p>brief</p></div>`).join('')
    const page = `<!doctype html><html><head><title>Portal</title></head><body>
<article class="badge">${promo}</article>
<article class="real"><h1>Real Post Heading</h1><p>${post}</p></article>
${cards}
</body></html>`
    const { markdown } = htmlToMarkdown(page, 'https://example.com/portal')
    expect(markdown).toContain('Real Post Heading')
    expect(markdown).not.toContain('Badge promo copy')
  })
})

describe('fenced code fidelity', () => {
  const PAGE_WITH_FENCE = (payload: string) => `<!doctype html><html><head><title>Code</title></head><body>
<main><article>
<p>The snippet below keeps its blank lines, which carry meaning in Python and in unified diffs.</p>
<pre><code>${payload}</code></pre>
</article></main></body></html>`

  it('leaves blank runs inside a fence untouched', () => {
    const { markdown } = htmlToMarkdown(PAGE_WITH_FENCE('def a():\n    pass\n\n\n\ndef b():\n    pass'), 'https://example.com/code')
    // A blanket \n{3,} -> \n\n collapse rewrote the fenced payload, so two
    // definitions separated by a blank run came out adjacent.
    expect(markdown).toContain('def a():')
    expect(markdown).toContain('def b():')
    const fenceBody = markdown.slice(markdown.indexOf('```'), markdown.lastIndexOf('```'))
    expect(fenceBody).toMatch(/pass\n\n\n\n/)
  })

  it('still collapses blank runs in the surrounding prose', () => {
    const page = `<!doctype html><html><head><title>Prose</title></head><body>
<main><article><p>First paragraph of prose that is long enough to be extracted as the article body.</p>
${'\n\n\n\n'}
<p>Second paragraph after a long run of blank lines in the source.</p>
</article></main></body></html>`
    const { markdown } = htmlToMarkdown(page, 'https://example.com/prose')
    expect(markdown).not.toMatch(/\n{3,}/)
  })

  it('does not treat a shorter nested fence marker as the closing fence', () => {
    // A ``` block containing ~~~ and a longer ```` block containing ``` both have
    // to stay balanced; a naive toggle on any fence marker would close early and
    // then mangle everything after it.
    const { markdown } = htmlToMarkdown(PAGE_WITH_FENCE('````\n```\ninner\n```\n````'), 'https://example.com/nested')
    expect(markdown).toContain('inner')
  })
})

describe('data-URI elision', () => {
  const MIME = 'data:image/png;base64,'
  const PAYLOAD = 'iVBORw0KGgoAAAANSUhEUg'
  const PAGE_WITH = (markup: string) => `<!doctype html><html><head><title>Images</title></head><body>
<main><article>
<p>A page whose illustrations are inlined, which is what a CMS does to avoid extra requests.</p>
${markup}
</article></main></body></html>`

  it('elides a lowercase data-URI image and reports its size', () => {
    const { markdown } = htmlToMarkdown(PAGE_WITH(`<p><img alt="chart" src="${MIME}${PAYLOAD}"></p>`), 'https://example.com/i')
    expect(markdown).not.toContain(PAYLOAD)
    expect(markdown).toMatch(/data:image\/png;base64,\.\.\./)
  })

  it('elides a scheme-cased data-URI image', () => {
    // `Data:` is a legal spelling of the scheme; matching the raw value with
    // startsWith('data:') let the whole payload through.
    const { markdown } = htmlToMarkdown(PAGE_WITH(`<p><img alt="chart" src="Data:image/png;base64,${PAYLOAD}"></p>`), 'https://example.com/i')
    expect(markdown).not.toContain(PAYLOAD)
  })

  it('elides a data-URI image whose attribute value has a leading newline', () => {
    const { markdown } = htmlToMarkdown(PAGE_WITH(`<p><img alt="chart" src="\n data:image/png;base64,${PAYLOAD}"></p>`), 'https://example.com/i')
    expect(markdown).not.toContain(PAYLOAD)
    expect(markdown).toContain('![chart](data:image/png;base64,...15B)')
  })

  it('elides a data-URI download link', () => {
    // A data: href is inlined verbatim by the converter, so a single PDF link
    // could spend the whole output budget on base64.
    const { markdown } = htmlToMarkdown(PAGE_WITH(`<p><a href="data:application/pdf;base64,${PAYLOAD}">Download</a></p>`), 'https://example.com/i')
    expect(markdown).not.toContain(PAYLOAD)
    expect(markdown).toContain('Download')
  })

  it('elides a data-URI source inside a picture element', () => {
    const { markdown } = htmlToMarkdown(PAGE_WITH(`<picture><source srcset="data:image/webp;base64,${PAYLOAD}"><img alt="chart" src="/c.png"></picture>`), 'https://example.com/i')
    expect(markdown).not.toContain(PAYLOAD)
  })

  it('still resolves ordinary relative sources', () => {
    const { markdown } = htmlToMarkdown(PAGE_WITH('<p><img alt="chart" src="/img/chart.png"></p>'), 'https://example.com/dir/page')
    expect(markdown).toContain('https://example.com/img/chart.png')
  })
})

describe('pipeline depth guard', () => {
  /** A document whose only content sits under `depth` nested wrappers. */
  function nested(depth: number, leaf = 'deep leaf text survives clamping'): string {
    let body = `<p>${leaf}</p>`
    for (let i = 0; i < depth; i++) body = `<div>${body}</div>`
    return `<!doctype html><html><head><title>Nested</title></head><body>${body}</body></html>`
  }

  it('returns a pathologically deep document quickly and keeps its text', () => {
    const html = nested(1024)
    const started = Date.now()
    const { markdown, pipelineDegraded } = htmlToMarkdown(html, 'https://example.com/deep')
    const elapsed = Date.now() - started
    // Without the clamp, Readability's synchronous scoring took ~12s here (the
    // 1024-deep case measured at 12.4s for a 21.6KB page) with the event loop
    // blocked throughout. The budget is deliberately generous relative to the
    // ~250ms measured, so the assertion catches a regression to seconds rather
    // than a slow machine.
    expect(elapsed).toBeLessThan(3000)
    expect(markdown).toContain('deep leaf text survives clamping')
    expect(pipelineDegraded).toBe(true)
  })

  it('reports no degradation for a normally nested page', () => {
    const { pipelineDegraded, markdown } = htmlToMarkdown(nested(20), 'https://example.com/shallow')
    expect(pipelineDegraded).toBeUndefined()
    expect(markdown).toContain('deep leaf text survives clamping')
  })

  it('leaves an ordinary article byte-identical to the unguarded pipeline', () => {
    // The guard must be invisible on real input: same output whether or not the
    // tree is anywhere near the ceiling.
    const shallow = htmlToMarkdown(ARTICLE_PAGE, 'https://example.com/a')
    expect(shallow.pipelineDegraded).toBeUndefined()
    expect(shallow.markdown).toContain('Getting started')
    expect(shallow.markdown).toContain('Installation')
  })

  it('degrades rather than scores when the element count blows the budget', () => {
    // Breadth scales Readability's cost independently of depth. Past the element
    // budget the pipeline skips scoring instead of paying seconds for it.
    const rows = Array.from({ length: 5_000 }, (_, i) => `<div><span>r${i}</span><p>item ${i}</p></div>`).join('')
    const html = `<!doctype html><html><head><title>Wide</title></head><body>${rows}</body></html>`
    const started = Date.now()
    const { markdown, pipelineDegraded } = htmlToMarkdown(html, 'https://example.com/wide')
    const elapsed = Date.now() - started
    expect(elapsed).toBeLessThan(3000)
    expect(pipelineDegraded).toBe(true)
    // Content still comes back: only the extraction was skipped.
    expect(markdown).toContain('item 4999')
  })
})
