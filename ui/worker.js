/**
 * Cloudflare Worker in front of the static site: `/data/*` is served straight from the R2
 * bucket binding with HTTP range support, everything else is the built app.
 *
 * Why not the bucket's public URL: r2.dev is HTTP/1.1 only, and a browser reusing keep-alive
 * connections against it stalls for seconds at a time on small range requests (see
 * plans/2026-09-04-r2-deploy.md). workers.dev is HTTP/2, and the binding bypasses the public
 * endpoint entirely. Plain JS so the app's tsconfig (DOM libs) does not need Workers types.
 */

const DATA_PREFIX = '/data/'

export default {
  /** @param {Request} request @param {{ DATA: R2Bucket, ASSETS: Fetcher }} env */
  async fetch(request, env) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith(DATA_PREFIX)) return env.ASSETS.fetch(request)
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 })

    const key = decodeURIComponent(url.pathname.slice(DATA_PREFIX.length))
    // the Range header (bytes=a-b, bytes=a-, bytes=-n) is parsed by R2 itself; the conditional
    // headers let the browser revalidate with If-None-Match against the object's ETag
    const object = await env.DATA.get(key, { range: request.headers, onlyIf: request.headers })
    if (object === null) return new Response('not found', { status: 404 })

    const headers = new Headers()
    object.writeHttpMetadata(headers)
    headers.set('ETag', object.httpEtag)
    headers.set('Accept-Ranges', 'bytes')
    // no-store, deliberately: Chrome keeps one cache entry per URL and serialises requests to
    // it, and every range request to a parquet file is the same URL. Cached 206 responses made
    // later ranges wait on the entry lock for seconds, up to Chrome's 20 s lock timeout.
    // DuckDB reads each footer once per session anyway, so the browser cache bought nothing.
    headers.set('Cache-Control', 'no-store')

    if (!('body' in object)) return new Response(null, { status: 304, headers })   // onlyIf matched

    let status = 200
    if (object.range) {
      const r = /** @type {{ offset?: number, length?: number, suffix?: number }} */ (object.range)
      const size = object.size
      const start = r.suffix != null ? size - r.suffix : (r.offset ?? 0)
      const end = r.suffix != null ? size - 1 : (r.length != null ? start + r.length - 1 : size - 1)
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      headers.set('Content-Length', String(end - start + 1))
      status = 206
    } else {
      headers.set('Content-Length', String(object.size))
    }
    return new Response(request.method === 'HEAD' ? null : object.body, { status, headers })
  },
}
