/**
 * DuckDB-WASM bootstrap. One database, one connection, shared by plain queries and by the
 * Mosaic coordinator. Only `search_index` is loaded whole; everything else is range-read from
 * `DATA_BASE` per query.
 */
import * as duckdb from '@duckdb/duckdb-wasm'
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url'
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url'

export const DATA_BASE: string =
  (import.meta.env.VITE_DATA_BASE as string | undefined)?.replace(/\/$/, '') || `${window.location.origin}/data`

export type Row = Record<string, unknown>

let dbPromise: Promise<{ db: duckdb.AsyncDuckDB; con: duckdb.AsyncDuckDBConnection }> | null = null

async function boot() {
  const bundles: duckdb.DuckDBBundles = {
    mvp: { mainModule: mvpWasm, mainWorker: mvpWorker },
    eh: { mainModule: ehWasm, mainWorker: ehWorker },
  }
  const bundle = await duckdb.selectBundle(bundles)
  const worker = new Worker(bundle.mainWorker!)
  const logger = new duckdb.VoidLogger()
  const db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  const con = await db.connect()
  // footers are fetched once per file per session
  await con.query(`SET parquet_metadata_cache = true`).catch(() => {})
  await con.query(
    `CREATE TABLE search_index AS SELECT * FROM read_parquet('${DATA_BASE}/search_index.parquet')`,
  )
  return { db, con }
}

export function getDB() {
  if (!dbPromise) dbPromise = boot()
  return dbPromise
}

/** Run SQL and return plain JS objects (BigInt -> number). */
export async function rows<T extends Row = Row>(sql: string): Promise<T[]> {
  const { con } = await getDB()
  const table = await con.query(sql)
  const out: T[] = []
  for (const r of table) {
    const o: Row = {}
    for (const [k, v] of Object.entries(r.toJSON())) o[k] = typeof v === 'bigint' ? Number(v) : v
    out.push(o as T)
  }
  return out
}

export async function one<T extends Row = Row>(sql: string): Promise<T | null> {
  const r = await rows<T>(sql)
  return r[0] ?? null
}

/** SQL string literal escaping for the few user-controlled strings we interpolate. */
export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export function parquet(path: string): string {
  return `read_parquet('${DATA_BASE}/${path}', hive_partitioning=false)`
}

// ---- Mosaic ---------------------------------------------------------------------------------
import { coordinator, wasmConnector } from '@uwdata/mosaic-core'

let mosaicReady: Promise<void> | null = null

/** Point the global Mosaic coordinator at our DuckDB instance (once). */
export function getCoordinator() {
  if (!mosaicReady) {
    mosaicReady = getDB().then(({ db, con }) => {
      coordinator().databaseConnector(wasmConnector({ duckdb: db, connection: con }))
    })
  }
  return mosaicReady.then(() => coordinator())
}

let locusSeq = 0
/** Materialize one locus (a gene's or phenotype's cis window) as an in-memory table for the
 *  plot and its linked views: one range read, then every Mosaic query is local. Returns the
 *  table name; caller drops it when done. */
export async function materializeLocus(sql: string): Promise<string> {
  const { con } = await getDB()
  const name = `locus_${++locusSeq}`
  await con.query(`CREATE TABLE ${name} AS ${sql}`)
  return name
}

export async function dropTable(name: string) {
  const { con } = await getDB()
  await con.query(`DROP TABLE IF EXISTS ${name}`).catch(() => {})
}
