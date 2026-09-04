import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { fileURLToPath, URL } from 'node:url'
import { createReadStream, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const DATA_DIR = fileURLToPath(new URL('../data/derived', import.meta.url))

/**
 * Serve ../data/derived at /data in `vite` and `vite preview`, with HTTP Range support, the
 * way R2 will serve it in production. This replaces a public/ symlink, which `vite build`
 * would copy wholesale (15 GB) into dist/.
 */
function serveDerivedData(): Plugin {
  const handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? ''
    if (!url.startsWith('/data/')) return next()
    const rel = normalize(decodeURIComponent(url.slice('/data/'.length).split('?')[0]))
    if (rel.startsWith('..')) { res.statusCode = 403; return res.end() }
    const file = join(DATA_DIR, rel)
    let size: number
    try { size = statSync(file).size } catch { res.statusCode = 404; return res.end() }
    const type = file.endsWith('.json') ? 'application/json' : 'application/octet-stream'
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', type)
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : range[1] ? size - 1 : size - 1
      if (start > end || start >= size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${size}`); return res.end() }
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      res.setHeader('Content-Length', String(end - start + 1))
      if (req.method === 'HEAD') return res.end()
      return createReadStream(file, { start, end }).pipe(res)
    }
    res.statusCode = 200
    res.setHeader('Content-Length', String(size))
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
  }
  return {
    name: 'serve-derived-data',
    configureServer(server) { server.middlewares.use(handler) },
    configurePreviewServer(server) { server.middlewares.use(handler) },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serveDerivedData()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // duckdb-wasm ships its own workers and wasm; pre-bundling breaks the worker URLs
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  build: { target: 'es2022' },
})
