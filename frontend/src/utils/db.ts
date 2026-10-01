/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 → v3 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - v3：拆两边归属（班组 / 技术组），新增对账待裁定表 recon 与班组同步发件箱 sync_outbox
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { ReconItem, OutboxItem } from '../types/recon'
import { nowIso, today } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>
  /** 两边对账待裁定条目 */
  recon!: Table<ReconItem, string>
  /** 班组同步发件箱（失败后按本侧重试） */
  sync_outbox!: Table<OutboxItem, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：加固件补齐「最近检查日期」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：拆两边归属（班组 / 技术组），新增对账与发件箱表 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner, needsReReview',
        surveys: 'id, treeId, [treeId+date], date, siteNote, side',
        measures: 'id, treeId, type, state, date, operator, side',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend, side',
        recon: 'id, kind, treeId, status',
        sync_outbox: 'id, side, table, status',
      })
      .upgrade(async (tx) => {
        // 迁移 5：已有数据归属缺失，第一次打开先迁移到两边再启用
        // 树体检查 / 复壮措施归班组（现场记录）；长势复评归技术组（定级）
        await tx.table('surveys').toCollection().modify((row: Record<string, unknown>) => {
          if (row.side !== 'team' && row.side !== 'tech') row.side = 'team'
          row.revision = ROW_REVISION
        })
        await tx.table('measures').toCollection().modify((row: Record<string, unknown>) => {
          if (row.side !== 'team' && row.side !== 'tech') row.side = 'team'
          row.revision = ROW_REVISION
        })
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (row.side !== 'team' && row.side !== 'tech') row.side = 'tech'
          row.revision = ROW_REVISION
        })
        // 迁移 6：加固件按字段拆分归属（检查周期归技术组、现场检查日期归班组），并补齐缺省值
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
          row.revision = ROW_REVISION
        })
        // 迁移 7：古树补齐「待技术组复评」标记
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.needsReReview !== 'boolean') row.needsReReview = false
          row.revision = ROW_REVISION
        })
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除古树并级联清理其检查、措施、加固与复评记录 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction('rw', db.trees, db.surveys, db.measures, db.supports, db.reviews, async () => {
    await db.surveys.where('treeId').equals(id).delete()
    await db.measures.where('treeId').equals(id).delete()
    await db.supports.where('treeId').equals(id).delete()
    await db.reviews.where('treeId').equals(id).delete()
    await db.trees.delete(id)
  })
}

/* ------------------------------ 树体检查 ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
}

/* ------------------------------ 复壮措施 ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施。
 * 措施状态为「已完成」时，回写古树的最近复壮日期（仅当本次日期更新时）。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.trees, db.measures, async () => {
    await db.measures.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (!tree) return
    if (tree.lastMeasureDate >= row.date) return
    await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
  })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/* ------------------------------ 加固件 ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSupport(id: string): Promise<void> {
  await db.supports.delete(id)
}

/** 登记本次检查：把最近检查日期置为给定日期（默认今天） */
export async function markSupportChecked(id: string, date = today()): Promise<void> {
  await db.supports.update(id, { lastCheckDate: date, updatedAt: nowIso() })
}

/* ------------------------------ 长势复评 ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
}

/* -------------------------- 对账待裁定 / 发件箱 -------------------------- */

export async function listRecon(): Promise<ReconItem[]> {
  const rows = await db.recon.toArray()
  return rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
    return b.createdAt.localeCompare(a.createdAt)
  })
}

export async function listOutbox(): Promise<OutboxItem[]> {
  const rows = await db.sync_outbox.toArray()
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
  recon: ReconItem[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, recon] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
    db.recon.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    trees,
    surveys,
    measures,
    supports,
    reviews,
    recon,
  }
}

/** 用快照覆盖整库（导入存档）；发件箱为本地瞬时状态，不随存档迁移 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.recon, db.sync_outbox], async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
      db.recon.clear(),
      db.sync_outbox.clear(),
    ])
    await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.supports.bulkPut(snapshot.supports.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.recon.bulkPut((snapshot.recon ?? []).map((row) => ({ ...row })))
  })
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.recon, db.sync_outbox], async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
      db.recon.clear(),
      db.sync_outbox.clear(),
    ])
  })
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.reviews.count(),
  ])
  return { trees, surveys, measures, supports, reviews }
}
