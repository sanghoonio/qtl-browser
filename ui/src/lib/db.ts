/**
 * DuckDB-WASM bootstrap. One database, one connection, shared by plain queries and by the
 * Mosaic coordinator. Only `search_index` is loaded whole; everything else is range-read from
 * `DATA_BASE` per query.
 */
import * as duckdb from '@duckdb/duckdb-wasm'

export const DATA_BASE: string =
  (import.meta.env.VITE_DATA_BASE as string | undefined)?.replace(/\/$/, '') || `${window.location.origin}/data`

export type Row = Record<string, unknown>

let dbPromise: Promise<{ db: duckdb.AsyncDuckDB; con: duckdb.AsyncDuckDBConnection }> | null = null

async function boot() {
  // the search index is one plain fetch started now, alongside the wasm download, and handed
  // to DuckDB as an in-memory file: one request instead of nine range reads after boot
  const indexBytes = fetch(`${DATA_BASE}/search_index.parquet`).then(r => {
    if (!r.ok) throw new Error(`search_index.parquet: ${r.status}`)
    return r.arrayBuffer()
  })
  // wasm and worker from jsDelivr (the 36 MB module is over the Workers asset limit). The
  // worker script is cross-origin, so it is loaded through a same-origin blob shim.
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles())
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }))
  const worker = new Worker(workerUrl)
  const logger = new duckdb.VoidLogger()
  const db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  URL.revokeObjectURL(workerUrl)
  // DuckDB-WASM defaults to downloading whole HTTP files (forceFullHTTPReads) unless told
  // otherwise; this is what makes every parquet read a Range request (HTTP 206) against R2
  await db.open({ filesystem: { forceFullHTTPReads: false, allowFullHTTPReads: true, reliableHeadRequests: true } })
  // every table file is registered under its relative path: DuckDB then opens it by name and
  // skips the HEAD it would otherwise send to resolve a raw URL on every query
  for (const f of TABLE_FILES) await db.registerFileURL(f, `${DATA_BASE}/${f}`, duckdb.DuckDBDataProtocol.HTTP, false)
  await db.registerFileBuffer('search_index.parquet', new Uint8Array(await indexBytes))
  const con = await db.connect()
  // footers are fetched once per file per session
  await con.query(`SET parquet_metadata_cache = true`).catch(() => {})
  await con.query(`CREATE TABLE search_index AS SELECT * FROM read_parquet('search_index.parquet')`)
  await db.dropFile('search_index.parquet').catch(() => {})   // the table holds it now
  // the per-gene tables are partitioned by chromosome and TSS bin; the index knows every bin
  const bins = (await con.query(`SELECT DISTINCT chr, bin FROM search_index WHERE bin IS NOT NULL`)).toArray()
  for (const r of bins) {
    for (const t of BINNED_TABLES) {
      const f = `${t}/chr=${r.chr}/bin=${r.bin}/data.parquet`
      await db.registerFileURL(f, `${DATA_BASE}/${f}`, duckdb.DuckDBDataProtocol.HTTP, false)
    }
  }
  return { db, con }
}

/** The data contract with the pipeline: single-file tables, the chromosome-partitioned ones
 *  (one file per chromosome), and the chromosome + bin ones (registered once the index is
 *  loaded). Exact paths throughout, since there is no directory listing over HTTP. */
const CHROMS = [...Array.from({ length: 22 }, (_, i) => `chr${i + 1}`), 'chrX']
const BINNED_TABLES = ['gene_detail', 'cis_eqtl_nominal', 'cis_sqtl_nominal']
const TABLE_FILES: string[] = [
  'genes.parquet', 'splice_phenotypes.parquet', 'credible_sets.parquet', 'coloc.parquet',
  'gwas_dcm_bins.parquet', 'gene_annotation.parquet', 'exons.parquet', 'variants_by_rsid.parquet',
  ...['gwas_dcm', 'variants_by_position', 'trans_pairs', 'trans_by_variant']
    .flatMap(t => CHROMS.map(c => `${t}/chr=${c}/data.parquet`)),
]

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
  // by registered name, not URL (see boot)
  return `read_parquet('${path}', hive_partitioning=false)`
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
