/**
 * @dsh-external/dsh-mermaid — browser half.
 *
 * The DSH web client renders every Markdown fence through `CodeBlock`, and the
 * fence's language never reaches the DOM (an unsupported language is shown as
 * the localized "code block" label). This plugin therefore reads `code`/`lang`
 * from the CodeBlock element's own React fiber — the object that produced the
 * DOM — and renders `mermaid` fences as diagrams with the source one click away.
 *
 * Two React facts shape the implementation:
 *   - The block's own `streaming` prop freezes at the value it had while the
 *     reply streamed (the settled parse reuses the streaming DOM), so "has the
 *     reply finished" is read from the OUTERMOST ancestor fiber that declares a
 *     boolean `streaming`, which does re-render when the turn settles.
 *   - The transcript mutates once per streamed token, so every scan is debounced
 *     and a fence whose source changed waits one beat before it is drawn.
 *
 * Mermaid itself shapes a third: its flowchart renderer keeps module-global state
 * and is not re-entrant, so renders are serialized and retried once. A diagram
 * that fails mid-draw (an out-of-range `linkStyle`, say) otherwise drags a
 * concurrently rendering neighbour down with it, and the neighbour's error is the
 * one the user ends up reading.
 *
 * Layout contract, all of it DOM-local so a host re-render cannot corrupt it:
 *   - `.md-code-block`             the CodeBlock root (literal class, both arms)
 *   - `[data-code-block-banner]`   its header (literal attribute, both variants)
 *   - the wrapper this plugin inserts as the root's next sibling
 * The original block is only hidden with an inline `display:none`, so dropping
 * the wrapper restores the untouched React tree.
 *
 * Mermaid itself is 3.5 MB, so it stays out of this bundle and arrives on the
 * first mermaid fence: from this package's own chunk served by the host
 * (`/plugins/<id>/client.mermaid.js`), with the public CDN as a fallback.
 */

window.__ModuleLoader__.load({
	id: '@dsh-external/dsh-mermaid',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		/** Boot-graph id: the package name, the same key the host serves chunks under. */
		const PLUGIN_ID = '@dsh-external/dsh-mermaid'
		/** Vendored mermaid UMD, served on demand by dsh-client-modules. */
		const CHUNK_FILE = 'client.mermaid.js'
		/** Public fallback when the package chunk is unavailable. */
		const CDN_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'
		/** Literal class on every Markdown code block. */
		const BLOCK_SELECTOR = '.md-code-block'
		/** Fence info strings treated as mermaid. */
		const LANGS = new Set(['mermaid', 'mmd'])
		/** How far up the fiber tree the settled `streaming` flag is searched. */
		const FIBER_DEPTH = 24
		/**
		 * Fallback recognizer for fences whose language is unknown in both
		 * directions (no fiber, or a fence with no info string). Only applied to
		 * unhighlighted blocks that Shiki did not render.
		 */
		const DIAGRAM_HEAD =
			/^\s*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|mindmap|timeline|zenuml|sankey-beta|xychart-beta|block-beta|packet-beta|kanban|architecture-beta|radar-beta|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment)\b/m
		/** Rescan debounce; the transcript mutates per streamed token. */
		const SCAN_DELAY_MS = 120
		/** How long a changed fence must hold still before it is drawn. */
		const SETTLE_DELAY_MS = 300

		// ---------------------------------------------------------------- state

		/** Code element -> { element, parts, code, pending, ok, mode, lang } */
		const tracked = new Map()
		/** Cached React fiber key suffix, discovered once per page. */
		let fiberKey = null
		/** Single in-flight mermaid load. */
		let mermaidLoad = null
		/**
		 * Diagram id counter, namespaced per plugin instance. Mermaid derives its
		 * temporary container ids from the id it is given, so two live instances
		 * (HMR keeps the old one running) must never agree on one — otherwise each
		 * deletes the other's container in the middle of a render.
		 */
		const RUN_ID = Math.random().toString(36).slice(2, 8)
		let diagramSeq = 0
		/**
		 * Serializes renders. Mermaid's flowchart renderer keeps module-global state
		 * (`flowDb`, edge styles, label positions) and is not re-entrant: overlapping
		 * renders can corrupt each other, and one diagram failing mid-draw can drag
		 * its neighbours down with it — hence one render at a time.
		 */
		let renderChain = Promise.resolve()
		/** Trailing-edge rescan timer and its deadline. */
		let scanTimer = 0
		let scanAt = 0
		/** Set once so a re-application cannot double-install. */
		let installed = false

		// ------------------------------------------------------------- mermaid

		/** Inject one classic script and resolve when it has executed. */
		function loadScript(src) {
			return new Promise((resolve, reject) => {
				const script = document.createElement('script')
				script.src = src
				script.async = true
				script.onload = () => resolve()
				script.onerror = () => {
					script.remove()
					reject(new Error('script failed: ' + src))
				}
				document.head.appendChild(script)
			})
		}

		/** This plugin's boot-graph revision, which the chunk route requires verbatim. */
		function packageRevision() {
			try {
				const entries = window.__DSH_BOOT__ && window.__DSH_BOOT__.entries
				const entry = Array.isArray(entries) ? entries.find((row) => row.id === PLUGIN_ID) : undefined
				return entry && typeof entry.rev === 'string' ? entry.rev : null
			} catch (_error) {
				return null
			}
		}

		/** Load mermaid once: this package's chunk first, the public CDN second. */
		function ensureMermaid() {
			if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid)
			if (mermaidLoad !== null) return mermaidLoad
			mermaidLoad = (async () => {
				const rev = packageRevision()
				if (rev !== null) {
					try {
						await loadScript(`/plugins/${PLUGIN_ID}/${CHUNK_FILE}?rev=${rev}`)
					} catch (_error) {
						/* fall through to the CDN */
					}
					if (globalThis.mermaid) return globalThis.mermaid
				}
				await loadScript(CDN_URL)
				if (!globalThis.mermaid) throw new Error('mermaid 未就绪')
				return globalThis.mermaid
			})().catch((error) => {
				mermaidLoad = null
				throw error
			})
			return mermaidLoad
		}

		/** True while the app paints the dark palette. */
		function isDark() {
			return document.body.hasAttribute('data-ds-dark-theme')
		}

		/**
		 * Drop mermaid's temporary render container. `render()` only runs its own
		 * cleanup on the success path, so a thrown parse or draw leaves `#d<id>` and
		 * its `<svg id="<id>">` behind in <body>, where the next render can trip over
		 * it. Published diagrams live inside the plugin's wrapper and are never touched.
		 * @param id - the id handed to `mermaid.render`.
		 */
		function dropTempContainers(id) {
			for (const node of [
				document.getElementById(id),
				document.getElementById('d' + id),
				document.getElementById('i' + id),
			]) {
				if (node === null || node.closest('[data-dsh-mermaid-host]') !== null) continue
				node.remove()
			}
		}

		/** Render one diagram source to `{ svg, bindFunctions }`. */
		async function renderSvg(code) {
			const mermaid = await ensureMermaid()
			mermaid.initialize({
				startOnLoad: false,
				securityLevel: 'strict',
				theme: isDark() ? 'dark' : 'default',
				flowchart: { useMaxWidth: true },
				sequence: { useMaxWidth: true },
				// Without this, mermaid 11 draws its own "bomb" error SVG into the
				// document on every parse failure — it lands at the end of <body> and
				// stays there across session switches. The plugin shows failures
				// inline (source + note), so the bomb is never wanted.
				suppressErrorRendering: true,
			})
			const id = `dsh-mm-${RUN_ID}-${++diagramSeq}`
			try {
				return await mermaid.render(id, code)
			} finally {
				dropTempContainers(id)
			}
		}

		/**
		 * Run one render at a time, retrying once. Mermaid leaks state after a failed
		 * draw, so a diagram that failed because a neighbour poisoned that state
		 * succeeds on a clean second attempt; a genuinely broken diagram simply fails
		 * twice and reports its own error.
		 * @param code - the fence source.
		 * @returns the render result.
		 */
		function enqueueRender(code) {
			const task = renderChain.then(() =>
				renderSvg(code).catch(async (first) => {
					await new Promise((resolve) => window.setTimeout(resolve, 60))
					try {
						return await renderSvg(code)
					} catch (_second) {
						throw first
					}
				}),
			)
			renderChain = task.then(
				() => undefined,
				() => undefined,
			)
			return task
		}

		/**
		 * Guess what is wrong with one source line, for the mistakes that actually
		 * happen when these diagrams are written by hand: a stray bracket inside an
		 * edge label, bare parentheses in a node label, or an unpaired quote.
		 * @param line - the offending source line, verbatim.
		 * @returns a one-line diagnosis, or `null` when nothing recognizable.
		 */
		function hintForLine(line) {
			if (typeof line !== 'string') return null
			// -->|文字| is the only edge-label form; brackets inside it end the label.
			if (/--+[>ox]?\s*\|[^|\n]*[[\]]/.test(line) || /--+[>ox]?\s*\|[^|\n]*[[\]]\s*\|/.test(line)) {
				return '边标签只能写成 -->|文字|，中间不能出现方括号 [ ]'
			}
			// Node text keeps its shape unless quoted; a bare ( ) is read as a shape.
			if (/[[{][^"\n]*[()][^"\n]*[\]}]/.test(line)) {
				return '节点文字里有半角括号 ( )，要把整段文字用双引号包起来，例如 A["文字(说明)"]'
			}
			if ((line.match(/"/g) || []).length % 2 === 1) {
				return '这一行的双引号没有配对'
			}
			return null
		}

		/** Turn mermaid's terse failure into something the next reader can act on. */
		function explain(error, code) {
			const message = error && error.message ? error.message : String(error)
			const parse = /Parse error on line (\d+)/m.exec(message)
			if (parse !== null) {
				const lineNo = Number(parse[1])
				const line = typeof code === 'string' ? (code.split('\n')[lineNo - 1] ?? '') : ''
				const trimmed = line.trim()
				const shown = trimmed.length > 0 ? `\n  ${trimmed.slice(0, 100)}${trimmed.length > 100 ? '…' : ''}` : ''
				const hint = hintForLine(line)
				const head = `语法错误（第 ${lineNo} 行）${shown}`
				return hint === null ? head : `${head}\n  原因：${hint}`
			}
			if (/setting 'style'|linkStyle/i.test(message)) {
				return `linkStyle 的下标超过了图的边数\n下标从 0 开始，N 条边的合法范围是 0…N-1`
			}
			if (/suitable point for the given distance/i.test(message)) {
				return `mermaid 布局算不出边标签的落点\n通常是边标签过长或节点过密；缩短标签或去掉 linkStyle 后重试`
			}
			if (/firstChild|properties of null|properties of undefined/i.test(message)) {
				return `${message}\nmermaid 的临时渲染容器被别的渲染清掉了；点“重试图示”通常即可恢复`
			}
			return message
		}

		// ------------------------------------------------------------- detection

		/** The React fiber key React attached to this DOM node, if any. */
		function fiberKeyOf(element) {
			if (fiberKey !== null && element[fiberKey] !== undefined) return fiberKey
			const found = Object.keys(element).find(
				(key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$'),
			)
			if (found !== undefined) fiberKey = found
			return found === undefined ? null : found
		}

		/**
		 * Walk up from the block to the fiber that owns its props. The block's own
		 * fiber carries only host props, so `code`/`lang` live one or two levels up.
		 */
		function codeBlockProps(element) {
			try {
				const key = fiberKeyOf(element)
				if (key === null) return null
				let fiber = element[key]
				for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.return) {
					const props = fiber.memoizedProps
					if (props && typeof props.code === 'string' && 'lang' in props) return props
				}
			} catch (_error) {
				return null
			}
			return null
		}

		/**
		 * Whether the reply that owns this block is still streaming. The nearest
		 * fibers answer for a frozen streaming render, so the OUTERMOST boolean
		 * wins: that one belongs to the message, which does re-render on settle.
		 * @returns {boolean | null} `null` when no fiber carries the flag.
		 */
		function isStreaming(element) {
			try {
				const key = fiberKeyOf(element)
				if (key === null) return null
				let fiber = element[key]
				let seen = null
				for (let depth = 0; fiber && depth < FIBER_DEPTH; depth++, fiber = fiber.return) {
					const props = fiber.memoizedProps
					if (props && typeof props.streaming === 'boolean') seen = props.streaming
				}
				return seen
			} catch (_error) {
				return null
			}
		}

		/**
		 * Classify one code block.
		 * @returns {{ code: string, streaming: boolean, confident: boolean } | null}
		 */
		function classify(element) {
			const props = codeBlockProps(element)
			const streaming = isStreaming(element) === true
			if (props !== null) {
				const lang = typeof props.lang === 'string' ? props.lang.trim().toLowerCase() : ''
				if (LANGS.has(lang)) return { code: props.code, streaming, confident: true }
				// An explicit non-mermaid language is never re-interpreted.
				if (lang !== '') return null
			}
			const pre = element.querySelector('pre')
			if (pre === null) return null
			if (pre.classList.contains('shiki') || pre.classList.contains('css-variables')) return null
			const code = pre.textContent || ''
			if (!DIAGRAM_HEAD.test(code)) return null
			return { code, streaming, confident: false }
		}

		// ------------------------------------------------------------------- dom

		/** Sheet id and revision; the revision is bumped whenever the rules change. */
		const STYLE_ID = 'dsh-mermaid-style'
		const STYLE_REVISION = '2026-10-28.2'

		/** Every rule this plugin owns, as one sheet. */
		const STYLE_TEXT = `
.dsh-mermaid{position:relative;margin:16px 0;border:.5px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-markdown-code-block,rgba(127,127,127,.06));overflow:hidden}
.dsh-mermaid-bar{display:flex;align-items:center;gap:8px;padding:6px 8px 6px 14px;font:11px/18px var(--dsw-font-family,system-ui);color:var(--dsw-alias-label-tertiary,#8a8a8a);background:var(--dsw-alias-markdown-code-block-banner,rgba(127,127,127,.07))}
.dsh-mermaid-bar .dsh-mermaid-grow{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mermaid-bar button{flex:none;background:none;border:0;padding:2px 8px;border-radius:var(--dsw-radius-sm,6px);color:inherit;font:inherit;cursor:pointer}
.dsh-mermaid-bar button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#555)}
.dsh-mermaid-bar button:disabled{opacity:.5;cursor:default}
.dsh-mermaid-canvas{display:flex;justify-content:center;padding:14px 10px;overflow:auto}
.dsh-mermaid-canvas svg{max-width:100%;height:auto}
.dsh-mermaid-canvas[data-zoomable]{cursor:zoom-in}
.dsh-mermaid-note{padding:8px 14px;font:11px/18px var(--dsw-font-family,system-ui);color:var(--dsw-alias-state-warning-primary,#b26a00);white-space:pre-wrap;word-break:break-word}
.dsh-mermaid-zoom{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;display:flex;flex-direction:column;background:rgba(14,14,16,.9);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.dsh-mermaid-zoom-bar{display:flex;align-items:center;gap:8px;flex:none;padding:10px 14px;font:12px/20px var(--dsw-font-family,system-ui);color:#e9e9ec;background:rgba(255,255,255,.07);border-bottom:1px solid rgba(255,255,255,.12)}
.dsh-mermaid-zoom-bar .grow{flex:0 1 auto;min-width:0;max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.92}
.dsh-mermaid-zoom-bar .dsh-mermaid-zoom-spacer{flex:1 1 auto;min-width:0}
.dsh-mermaid-zoom-bar button{flex:none;background:rgba(255,255,255,.11);border:0;border-radius:6px;color:inherit;font:inherit;padding:3px 10px;cursor:pointer}
.dsh-mermaid-zoom-bar button:hover{background:rgba(255,255,255,.22)}
.dsh-mermaid-zoom-pct{flex:none;min-width:54px;text-align:center;font-variant-numeric:tabular-nums;opacity:.82}
.dsh-mermaid-zoom-stage{position:relative;flex:1 1 auto;overflow:hidden;cursor:grab;touch-action:none}
.dsh-mermaid-zoom-stage[data-dragging]{cursor:grabbing}
.dsh-mermaid-zoom-paper{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}
.dsh-mermaid-zoom-paper svg{display:block;max-width:none!important;height:auto}
.dsh-mermaid-zoom-hint{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);pointer-events:none;font:11px/18px var(--dsw-font-family,system-ui);color:rgba(255,255,255,.45)}
`

		/**
		 * Install the plugin stylesheet.
		 *
		 * It always rewrites the sheet rather than returning early when one is already
		 * present: client HMR swaps this module while the previous generation's
		 * `<style>` element is still in `<head>`, so an early return silently drops
		 * every rule added since. That is exactly how the full-screen viewer once
		 * rendered as an unstyled block at the bottom of the page.
		 */
		function ensureStyles() {
			let style = document.getElementById(STYLE_ID)
			if (style === null) {
				style = document.createElement('style')
				style.id = STYLE_ID
				document.head.appendChild(style)
			}
			if (style.dataset.revision === STYLE_REVISION) return
			style.dataset.revision = STYLE_REVISION
			style.textContent = STYLE_TEXT
		}

		/** Create the wrapper that carries the diagram, its bar and its controls. */
		function createWrapper() {
			const wrapper = document.createElement('div')
			wrapper.className = 'dsh-mermaid'
			wrapper.setAttribute('data-dsh-mermaid-host', '')
			const bar = document.createElement('div')
			bar.className = 'dsh-mermaid-bar'
			const label = document.createElement('span')
			label.className = 'dsh-mermaid-grow'
			label.textContent = 'Mermaid 图（生成中…）'
			const toggle = document.createElement('button')
			toggle.type = 'button'
			const zoom = document.createElement('button')
			zoom.type = 'button'
			zoom.textContent = '放大'
			zoom.title = '全屏查看，可滚轮缩放、拖动平移'
			const copy = document.createElement('button')
			copy.type = 'button'
			copy.textContent = '复制源码'
			bar.append(label, toggle, zoom, copy)
			const note = document.createElement('div')
			note.className = 'dsh-mermaid-note'
			note.hidden = true
			const canvas = document.createElement('div')
			canvas.className = 'dsh-mermaid-canvas'
			wrapper.append(bar, note, canvas)
			return { wrapper, label, toggle, zoom, copy, note, canvas }
		}

		/** Apply the current mode to one tracked block: source shown, or diagram. */
		function applyMode(entry) {
			const showDiagram = entry.mode === 'diagram' && entry.ok
			entry.element.style.display = showDiagram ? 'none' : ''
			entry.parts.canvas.hidden = !showDiagram
			entry.parts.toggle.textContent = entry.ok ? (entry.mode === 'diagram' ? '查看源码' : '查看图示') : '重试图示'
			entry.parts.toggle.disabled = !entry.ok && entry.code === null
			entry.parts.zoom.disabled = !entry.ok
			if (entry.ok) entry.parts.canvas.setAttribute('data-zoomable', '')
			else entry.parts.canvas.removeAttribute('data-zoomable')
			entry.parts.label.textContent = entry.ok
				? 'Mermaid 图 · ' + entry.lang
				: entry.code === null
					? 'Mermaid 图（生成中…）'
					: 'Mermaid（未渲染，已保留源码）'
		}

		/** Ensure the wrapper exists and is still the block's next sibling. */
		function ensureWrapper(element, lang) {
			let entry = tracked.get(element)
			if (entry === undefined) {
				const parts = createWrapper()
				entry = { element, parts, code: null, pending: undefined, ok: false, mode: 'diagram', lang }
				parts.toggle.addEventListener('click', () => {
					if (!entry.ok) {
						// Retry the failed render instead of toggling nothing.
						entry.code = null
						entry.pending = undefined
						schedule(0)
						return
					}
					entry.mode = entry.mode === 'diagram' ? 'source' : 'diagram'
					applyMode(entry)
				})
				parts.copy.addEventListener('click', () => {
					navigator.clipboard?.writeText(entry.code || '').catch(() => undefined)
				})
				// Both the bar button and the diagram itself open the viewer, so the
				// "看不清" case is one click away instead of a menu hunt.
				const enlarge = () => {
					if (!entry.ok) return
					const svg = entry.parts.canvas.querySelector('svg')
					if (svg !== null) openViewer(svg, entry.parts.label.textContent, entry)
				}
				parts.zoom.addEventListener('click', enlarge)
				// Click-to-enlarge, but only for a real click: dragging the canvas to
				// scroll a wide diagram must not pop the viewer open.
				let pressedAt = null
				parts.canvas.addEventListener('pointerdown', (event) => {
					pressedAt = { x: event.clientX, y: event.clientY }
				})
				parts.canvas.addEventListener('click', (event) => {
					if (event.target instanceof Element && event.target.closest('a') !== null) return
					if (pressedAt !== null && (Math.abs(event.clientX - pressedAt.x) > 4 || Math.abs(event.clientY - pressedAt.y) > 4)) return
					enlarge()
				})
				tracked.set(element, entry)
			}
			entry.lang = lang
			if (!entry.parts.wrapper.isConnected) element.insertAdjacentElement('afterend', entry.parts.wrapper)
			return entry
		}

		/** Remove our DOM and restore the untouched code block. */
		function teardown(entry) {
			entry.element.style.display = ''
			entry.parts.wrapper.remove()
			tracked.delete(entry.element)
			// Dropping the block drops its viewer too — unless the viewer is showing a
			// different diagram, which a transcript re-render must not close.
			if (closeViewer !== null && viewerEntry === entry) closeViewer()
		}

		// ---------------------------------------------------------------- viewer

		/** Smallest and largest accepted viewer scale. */
		const VIEWER_MIN_SCALE = 0.1
		const VIEWER_MAX_SCALE = 8
		/** Closes the open viewer, or `null` when none is open. */
		let closeViewer = null
		/** Tracked entry whose diagram the open viewer is showing. */
		let viewerEntry = null

		/** Natural (viewBox) size of a rendered mermaid SVG. */
		function svgSize(svg) {
			const box = svg && svg.viewBox && svg.viewBox.baseVal
			if (box !== undefined && box !== null && box.width > 0 && box.height > 0) {
				return { width: box.width, height: box.height }
			}
			const rect = svg.getBoundingClientRect()
			return { width: Math.max(rect.width, 320), height: Math.max(rect.height, 240) }
		}

		/**
		 * Height of the Windows caption strip the shell reserves above its content.
		 *
		 * The desktop build draws native minimize/maximize/close buttons in that strip,
		 * and native controls always sit above page content — so a viewer that starts
		 * at y=0 and parks its own close button in the same corner hands real clicks to
		 * the window's ✕ (it quit the app once). The shell publishes the height on
		 * `<html>` and its own overlays pad by it; this plugin does the same.
		 * @returns the strip height in CSS pixels, or 0 outside a Windows shell.
		 */
		function captionHeight() {
			const html = document.documentElement
			if (!html.hasAttribute('data-windows-titlebar') || html.hasAttribute('data-fullscreen')) return 0
			const parsed = Number.parseFloat(html.style.getPropertyValue('--dsh-windows-titlebar-height'))
			return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
		}

		/**
		 * Open one diagram in a full-viewport viewer: wheel zoom around the pointer,
		 * drag to pan, click anywhere to dismiss, Escape to close.
		 *
		 * The overlay is a body-level sibling holding a *clone* of the diagram, so it
		 * never touches the React-owned transcript and cannot be reconciled away.
		 * @param svg - the rendered diagram currently in the transcript.
		 * @param title - the wrapper's label, reused as the dialog name.
		 * @param entry - the tracked block the diagram belongs to.
		 */
		function openViewer(svg, title, entry) {
			if (closeViewer !== null) closeViewer()
			const size = svgSize(svg)
			const restoreFocus = document.activeElement
			const previousOverflow = document.body.style.overflow

			const root = document.createElement('div')
			root.className = 'dsh-mermaid-zoom'
			root.setAttribute('role', 'dialog')
			root.setAttribute('aria-modal', 'true')
			root.setAttribute('aria-label', title)

			const bar = document.createElement('div')
			bar.className = 'dsh-mermaid-zoom-bar'
			const name = document.createElement('span')
			name.className = 'grow'
			name.textContent = title
			const pct = document.createElement('span')
			pct.className = 'dsh-mermaid-zoom-pct'
			const action = (text, label, onClick) => {
				const node = document.createElement('button')
				node.type = 'button'
				node.textContent = text
				node.setAttribute('aria-label', label)
				node.title = label
				node.addEventListener('click', onClick)
				return node
			}
			const closeButton = action('✕ 关闭', '关闭（单击图、Esc 也可以）', () => dismiss())
			const zoomOutButton = action('−', '缩小', () => zoomBy(1 / 1.25))
			const zoomInButton = action('+', '放大', () => zoomBy(1.25))
			const fitButton = action('适应', '适应窗口', () => fitToStage())
			const unitButton = action('1:1', '原始大小', () => setScaleCentered(1))
			// Controls cluster to the LEFT and a spacer eats the rest of the bar: the
			// caption's native buttons always win the top-right corner, so nothing of
			// this plugin may live there.
			const spacer = document.createElement('span')
			spacer.className = 'dsh-mermaid-zoom-spacer'
			bar.append(closeButton, name, zoomOutButton, pct, zoomInButton, fitButton, unitButton, spacer)

			const stage = document.createElement('div')
			stage.className = 'dsh-mermaid-zoom-stage'
			const paper = document.createElement('div')
			paper.className = 'dsh-mermaid-zoom-paper'
			const clone = svg.cloneNode(true)
			clone.removeAttribute('style')
			clone.setAttribute('width', String(size.width))
			clone.setAttribute('height', String(size.height))
			paper.append(clone)
			const hint = document.createElement('div')
			hint.className = 'dsh-mermaid-zoom-hint'
			hint.textContent = '单击关闭 · 滚轮缩放 · 拖动平移 · Esc 关闭'
			stage.append(paper, hint)
			root.append(bar, stage)
			// Clear the caption strip so the window's own buttons stay reachable and
			// unmistakably theirs.
			root.style.paddingTop = `${captionHeight() + 6}px`

			// The viewport-pinning layout is inlined on purpose. A stylesheet that is
			// missing, stale, or outranked by the host's own CSS must never drop the
			// viewer back into document flow, where it lands under the whole page.
			Object.assign(root.style, {
				position: 'fixed',
				top: '0',
				right: '0',
				bottom: '0',
				left: '0',
				zIndex: '2147483000',
				display: 'flex',
				flexDirection: 'column',
				background: 'rgba(14,14,16,.9)',
			})
			Object.assign(bar.style, { display: 'flex', alignItems: 'center', gap: '8px', flex: 'none' })
			// `cursor` deliberately stays in the sheet: an inline value would outrank the
			// `[data-dragging]` rule that swaps grab for grabbing mid-drag.
			Object.assign(stage.style, { position: 'relative', flex: '1 1 auto', overflow: 'hidden', touchAction: 'none' })
			Object.assign(paper.style, { position: 'absolute', top: '0', left: '0', transformOrigin: '0 0' })

			let scale = 1
			let tx = 0
			let ty = 0
			let fitted = true
			/** Accumulated pointer travel during the current press, so a pan never counts as a click. */
			let dragged = 0

			/** Stage viewport size in CSS pixels. */
			function stageBox() {
				const rect = stage.getBoundingClientRect()
				return { width: rect.width, height: rect.height }
			}

			/** Push the current transform into the DOM and the readout. */
			function apply() {
				paper.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
				pct.textContent = `${Math.round(scale * 100)}%`
			}

			/** Zoom to an absolute scale while keeping the stage point (cx, cy) fixed. */
			function zoomAt(next, cx, cy) {
				const clamped = Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE, next))
				if (clamped === scale) return
				tx = cx - ((cx - tx) * clamped) / scale
				ty = cy - ((cy - ty) * clamped) / scale
				scale = clamped
				fitted = false
				apply()
			}

			/** Zoom relative to the stage centre, for the +/− buttons and keys. */
			function zoomBy(factor) {
				const box = stageBox()
				zoomAt(scale * factor, box.width / 2, box.height / 2)
			}

			/** Center the diagram at an absolute scale. */
			function setScaleCentered(next) {
				const box = stageBox()
				scale = Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE, next))
				tx = (box.width - size.width * scale) / 2
				ty = (box.height - size.height * scale) / 2
				fitted = false
				apply()
			}

			/** Fit the whole diagram with a comfortable margin, then center it. */
			function fitToStage() {
				const box = stageBox()
				const pad = 48
				const fit = Math.min((box.width - pad) / size.width, (box.height - pad) / size.height)
				scale = Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE, fit))
				tx = (box.width - size.width * scale) / 2
				ty = (box.height - size.height * scale) / 2
				fitted = true
				apply()
			}

			function onWheel(event) {
				event.preventDefault()
				event.stopPropagation()
				const rect = stage.getBoundingClientRect()
				const factor = Math.exp(-event.deltaY * 0.0015)
				zoomAt(scale * factor, event.clientX - rect.left, event.clientY - rect.top)
			}

			function onPointerDown(event) {
				if (event.button !== 0) return
				const startX = event.clientX
				const startY = event.clientY
				const startTx = tx
				const startTy = ty
				dragged = 0
				stage.setAttribute('data-dragging', '')
				// A capture request can be refused (synthetic or already-released
				// pointer); dragging still works through the bubble path below.
				if (typeof stage.setPointerCapture === 'function') {
					try {
						stage.setPointerCapture(event.pointerId)
					} catch (_error) {
						/* no active pointer to capture */
					}
				}
				event.preventDefault()
				const move = (moveEvent) => {
					tx = startTx + (moveEvent.clientX - startX)
					ty = startTy + (moveEvent.clientY - startY)
					dragged = Math.max(dragged, Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY))
					fitted = false
					apply()
				}
				const stop = () => {
					stage.removeAttribute('data-dragging')
					stage.removeEventListener('pointermove', move)
					stage.removeEventListener('pointerup', stop)
					stage.removeEventListener('pointercancel', stop)
				}
				stage.addEventListener('pointermove', move)
				stage.addEventListener('pointerup', stop)
				stage.addEventListener('pointercancel', stop)
			}

			/**
			 * Clicking the diagram dismisses the viewer — that is the fastest way out,
			 * so it is the primary gesture and Escape/✕ only back it up. A pan and a
			 * link keep their own meaning.
			 */
			function onStageClick(event) {
				if (dragged > 4) return
				if (event.target instanceof Element && event.target.closest('a') !== null) return
				dismiss()
			}

			function onKeyDown(event) {
				if (event.key === 'Escape') {
					event.preventDefault()
					event.stopPropagation()
					dismiss()
					return
				}
				if (event.key === '+' || event.key === '=') {
					event.preventDefault()
					zoomBy(1.25)
				} else if (event.key === '-' || event.key === '_') {
					event.preventDefault()
					zoomBy(1 / 1.25)
				} else if (event.key === '0') {
					event.preventDefault()
					fitToStage()
				}
			}

			function onResize() {
				if (fitted) fitToStage()
			}

			function dismiss() {
				document.removeEventListener('keydown', onKeyDown, true)
				window.removeEventListener('resize', onResize)
				stage.removeEventListener('wheel', onWheel)
				stage.removeEventListener('pointerdown', onPointerDown)
				stage.removeEventListener('click', onStageClick)
				root.remove()
				document.body.style.overflow = previousOverflow
				if (closeViewer === dismiss) closeViewer = null
				if (viewerEntry === entry) viewerEntry = null
				if (restoreFocus instanceof HTMLElement && restoreFocus.isConnected) restoreFocus.focus()
			}

			document.body.style.overflow = 'hidden'
			document.body.appendChild(root)
			stage.addEventListener('wheel', onWheel, { passive: false })
			stage.addEventListener('pointerdown', onPointerDown)
			stage.addEventListener('click', onStageClick)
			document.addEventListener('keydown', onKeyDown, true)
			window.addEventListener('resize', onResize)
			closeViewer = dismiss
			viewerEntry = entry ?? null
			fitToStage()
			closeButton.focus()
			return dismiss
		}

		/** Render (or re-render) one block, then settle the mode. */
		async function draw(entry, code) {
			if (entry.code === code) return
			entry.code = code
			try {
				const result = await enqueueRender(code)
				if (entry.code !== code) return
				entry.parts.canvas.innerHTML = result.svg
				if (typeof result.bindFunctions === 'function') result.bindFunctions(entry.parts.canvas)
				entry.parts.note.hidden = true
				entry.ok = true
			} catch (error) {
				if (entry.code !== code) return
				entry.parts.canvas.textContent = ''
				entry.parts.note.textContent = '图示渲染失败：' + explain(error, code)
				entry.parts.note.hidden = false
				entry.ok = false
				entry.mode = 'source'
				removeStrayErrorArtifacts()
			}
			applyMode(entry)
		}

		/**
		 * Delete any error SVG mermaid leaked into the document. `render()` can
		 * append its "bomb" diagram to <body> on a parse failure (older chunk in
		 * cache, or a CDN fallback without `suppressErrorRendering`); it then
		 * sits at the bottom of the page for the rest of the app session.
		 */
		function removeStrayErrorArtifacts() {
			try {
				for (const svg of document.querySelectorAll('body > svg')) {
					const text = svg.textContent || ''
					if (/Syntax error in text|mermaid version \d/.test(text)) svg.remove()
				}
				removeLeakedContainers()
			} catch (_error) {
				/* cleanup is best-effort */
			}
		}

		/**
		 * Sweep temporary containers that an earlier failure (or an earlier plugin
		 * generation, whose id scheme differed) left as direct children of <body>.
		 * The plugin's own wrappers are nested inside the transcript, so they can
		 * never match this selector.
		 */
		function removeLeakedContainers() {
			for (const node of document.querySelectorAll('body > [id]')) {
				if (node.id === 'dsh-mermaid-style') continue
				if (!/^dd?sh-(?:mm|mermaid)-/.test(node.id)) continue
				node.remove()
			}
		}

		/** Classify every mounted code block; render the settled mermaid ones. */
		function scan() {
			const live = new Set()
			for (const element of document.querySelectorAll(BLOCK_SELECTOR)) {
				if (!element.isConnected) continue
				const info = classify(element)
				if (info === null) continue
				live.add(element)
				const entry = ensureWrapper(element, info.confident ? 'mermaid' : 'mermaid（推断）')
				if (info.streaming) {
					// Still growing: keep the source readable instead of drawing half a
					// diagram, and let the settle mutation bring us back here.
					if (entry.code === null) applyMode(entry)
					continue
				}
				if (entry.pending !== info.code) {
					// First sight of this exact source: wait one beat so a fence that is
					// still arriving token by token is never drawn mid-flight.
					entry.pending = info.code
					schedule(SETTLE_DELAY_MS)
					continue
				}
				void draw(entry, info.code)
			}
			for (const entry of [...tracked.values()]) {
				if (!live.has(entry.element) || !entry.element.isConnected) teardown(entry)
			}
		}

		/** Trailing-edge rescan; the transcript mutates once per streamed token. */
		function schedule(delay = SCAN_DELAY_MS) {
			const at = Date.now() + delay
			if (scanTimer !== 0) {
				// An earlier deadline already covers this request.
				if (scanAt <= at) return
				window.clearTimeout(scanTimer)
			}
			scanAt = at
			scanTimer = window.setTimeout(() => {
				scanTimer = 0
				try {
					scan()
				} catch (_error) {
					/* never let a scan failure break the transcript */
				}
			}, delay)
		}

		// --------------------------------------------------------------- install

		/** Observe the transcript and the palette, then scan what is already mounted. */
		function install() {
			if (installed) return () => undefined
			installed = true
			ensureStyles()
			// Containers leaked by failures from an earlier plugin generation would
			// otherwise sit in <body> for the rest of the page's life.
			removeLeakedContainers()
			const observer = new MutationObserver(() => schedule())
			observer.observe(document.body, { childList: true, subtree: true, characterData: true })
			// Repaint diagrams when the palette flips.
			const themeObserver = new MutationObserver(() => {
				for (const entry of tracked.values()) entry.code = null
				schedule()
			})
			themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
			schedule()
			return () => {
				installed = false
				observer.disconnect()
				themeObserver.disconnect()
				if (scanTimer !== 0) window.clearTimeout(scanTimer)
				scanTimer = 0
				for (const entry of [...tracked.values()]) teardown(entry)
				// Nothing may outlive the plugin's own teardown, viewer included.
				if (closeViewer !== null) closeViewer()
			}
		}

		/**
		 * Register the transcript observer.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const dispose = install()
			if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose)
		}

		// Debug handle, so a browser console can drive the scanner directly.
		Object.defineProperty(globalThis, '__dshMermaid', {
			value: { scan, schedule, tracked, ensureMermaid, ensureStyles },
			configurable: true,
		})

		exports.name = 'dsh-mermaid'
		exports.inject = []
		exports.apply = apply
		return module.exports
	},
})
