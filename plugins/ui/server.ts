import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { parseDocument } from 'yaml'
import { peakEnvelope } from '#kernel/wav.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

export type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean

export function json(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

export function notFound(res: ServerResponse, message = 'not found'): void {
  json(res, { error: message }, 404)
}

/** Reads a request body with a ceiling, so a stray upload cannot fill memory. */
export async function readBody(req: IncomingMessage, limitBytes = 4 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Streams an upload straight to disk; songs are far too big to buffer. */
export async function saveUpload(req: IncomingMessage, target: string): Promise<number> {
  mkdirSync(resolve(target, '..'), { recursive: true })
  const out = createWriteStream(target)
  await pipeline(req, out)
  return statSync(target).size
}

/**
 * Serves a file with byte-range support, which is what lets the browser seek in
 * a stem without downloading all of it first.
 */
export function serveFile(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) return notFound(res)
  const size = statSync(path).size
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)

  if (range) {
    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size || start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
    })
    createReadStream(path, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' })
  createReadStream(path).pipe(res)
}

/** Resolves a path inside a root, refusing anything that escapes it. */
export function safeJoin(root: string, relative: string): string {
  const path = resolve(root, normalize(relative).replace(/^(\.\.[/\\])+/, ''))
  if (!path.startsWith(resolve(root))) throw new Error(`path escapes the workspace: ${relative}`)
  return path
}

export function peaksFor(path: string, buckets: number) {
  return peakEnvelope(path, buckets)
}

export function createHttpServer(handler: Handler): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    Promise.resolve(handler(req, res, url))
      .then((handled) => {
        if (!handled && !res.headersSent) notFound(res)
      })
      .catch((error: Error) => {
        if (!res.headersSent) json(res, { error: error.message }, 500)
        else res.end()
      })
  })
}

/**
 * Rewrites one plugin's entry in `musician.config.yaml`, preserving comments and
 * formatting, and lets the loader's watcher do the rest. The UI changing which
 * separator is mounted is the same act as a person editing the file.
 */
export function swapPluginInConfig(
  configPath: string,
  options: { remove: string[]; add: string; config: Record<string, unknown> },
): void {
  const document = parseDocument(readFileSync(configPath, 'utf8'))
  const plugins = document.get('plugins') as any
  if (!plugins) throw new Error(`${configPath} has no "plugins" map`)
  for (const name of options.remove) {
    if (name !== options.add) plugins.delete(name)
  }
  if (!plugins.has(options.add)) plugins.set(options.add, options.config)
  writeFileSync(configPath, document.toString())
}

export function staticDir(root: string): string {
  return join(root, 'ui', 'dist')
}
