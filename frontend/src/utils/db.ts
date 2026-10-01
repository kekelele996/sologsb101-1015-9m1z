/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - v1 建表；v2 补索引与回写字段；v3「两侧分账」：
 *   班组（树体检查 / 复壮措施 / 加固件现场检查日期）与
 *   技术组（加固件检查周期 / 长势复评定级）拆成两侧台账，互不覆盖，
 *   首启先把历史数据迁移到两侧（owner + 两侧时间戳 + 同步状态），再启用分账。
 * - 按侧写入 API：班组写 crew* / 技术组写 tech*，任一侧都不会整行覆盖另一侧。
 * - 对不上的差异写 discrepancies 表，由对账页等人裁定。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { LedgerDiscrepancy, MetaKey } from '../types/ledger'
import { nowIso, today } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

/** 元信息默认值（meta 表 key/value） */
export const META_DEFAULTS: Record<MetaKey, string> = {
  ledgerSplitEnabled: 'true',
  simulateOffline: 'false',
  lastCrewSyncAt: '',
}

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>
  discrepancies!: Table<LedgerDiscrepancy, string>
  meta!: Table<{ key: MetaKey; value: string }, string>

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
    this.version(2).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
      surveys: 'id, treeId, [treeId+date], date, siteNote',
      measures: 'id, treeId, type, state, date, operator',
      supports: 'id, treeId, type, installDate, lastCheckDate',
      reviews: 'id, treeId, date, vigor, trend',
    })

    // ---------- v3：两侧分账（班组 / 技术组）----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote, owner, syncState',
        measures: 'id, treeId, type, state, date, operator, owner, syncState',
        // techCheckDate：技术组侧已确认的检查日期；syncState：检查日期同步状态
        supports:
          'id, treeId, type, installDate, lastCheckDate, techCheckDate, owner, syncState',
        reviews: 'id, treeId, date, vigor, trend, owner',
        discrepancies: 'id, entity, recordId, treeId, status, foundAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const stamp = nowIso()

        // 迁移 1：树体检查 → 班组侧现场记录，历史数据同时在技术组侧确认
        await tx
          .table('surveys')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            row.owner = 'crew'
            row.crewUpdatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : stamp
            row.techAckAt = typeof row.updatedAt === 'string' ? row.updatedAt : stamp
            row.syncState = 'synced'
            row.lastSyncAt = stamp
            row.syncError = ''
            row.updatedAt = stamp
            row.revision = ROW_REVISION
          })

        // 迁移 2：复壮措施 → 班组侧现场记录
        await tx
          .table('measures')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            row.owner = 'crew'
            row.crewUpdatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : stamp
            row.techAckAt = typeof row.updatedAt === 'string' ? row.updatedAt : stamp
            row.syncState = 'synced'
            row.lastSyncAt = stamp
            row.syncError = ''
            row.updatedAt = stamp
            row.revision = ROW_REVISION
          })

        // 迁移 3：加固件 → 周期归技术组、现场检查日期归班组，旧值两边各存一份
        await tx
          .table('supports')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
            if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
            // 历史检查日期原样复制到技术组侧，视为两侧本来一致（不产生差异）
            row.techCheckDate = row.lastCheckDate
            row.owner = 'crew'
            row.crewUpdatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : stamp
            row.techAckAt = typeof row.updatedAt === 'string' ? row.updatedAt : stamp
            row.syncState = 'synced'
            row.lastSyncAt = stamp
            row.syncError = ''
            row.updatedAt = stamp
            row.revision = ROW_REVISION
          })

        // 迁移 4：长势复评 → 技术组侧定级（技术组定级不被班组改写）
        await tx
          .table('reviews')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            row.owner = 'tech'
            row.techUpdatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : stamp
            row.updatedAt = stamp
            row.revision = ROW_REVISION
          })

        // 迁移 5：历史数据已分到两侧，置「分账已启用」标记（先迁移、再启用）
        await tx.table('meta').bulkPut(
          (Object.keys(META_DEFAULTS) as MetaKey[]).map((key) => ({ key, value: META_DEFAULTS[key] }))
        )
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 元信息 ------------------------------ */

export async function getMeta(key: MetaKey): Promise<string> {
  const row = await db.meta.get(key)
  return row?.value ?? META_DEFAULTS[key]
}

export async function setMeta(key: MetaKey, value: string): Promise<void> {
  await db.meta.put({ key, value })
}

/** 分账是否已启用（v3 首启迁移完成后置 true） */
export async function isLedgerSplitEnabled(): Promise<boolean> {
  return (await getMeta('ledgerSplitEnabled')) === 'true'
}

/** 是否模拟「班组 → 技术组」同步链路离线（演示同步失败与按本侧重试） */
export async function isSimulateOffline(): Promise<boolean> {
  return (await getMeta('simulateOffline')) === 'true'
}

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * v3 升级时 Dexie 先执行「分到两侧」的迁移，完成后才 resolve，
 * 因此页面首次拿到数据时分账一定已启用。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 兜底：升级路径之外（如清空 meta）确保分账标记存在
      if ((await db.meta.get('ledgerSplitEnabled')) === undefined) {
        await setMeta('ledgerSplitEnabled', META_DEFAULTS.ledgerSplitEnabled)
      }
      if ((await db.meta.get('simulateOffline')) === undefined) {
        await setMeta('simulateOffline', META_DEFAULTS.simulateOffline)
      }
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

/** 删除古树并级联清理其检查、措施、加固、复评与待裁定差异 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.discrepancies],
    async () => {
      await db.surveys.where('treeId').equals(id).delete()
      await db.measures.where('treeId').equals(id).delete()
      await db.supports.where('treeId').equals(id).delete()
      await db.reviews.where('treeId').equals(id).delete()
      await db.discrepancies.where('treeId').equals(id).delete()
      await db.trees.delete(id)
    }
  )
}

/* ------------------------- 树体检查（班组侧） ------------------------- */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/** 班组侧写入树体检查：只写现场字段，班组新登记默认待同步到技术组 */
export async function putCrewSurvey(row: Survey): Promise<void> {
  const stamp = nowIso()
  await db.surveys.put({
    ...row,
    owner: 'crew',
    crewUpdatedAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  })
}

/** 同步引擎专用：技术组侧确认后回写同步状态，不触碰班组现场值 */
export async function markSurveySynced(id: string, ackAt: string): Promise<void> {
  await db.surveys.update(id, {
    techAckAt: ackAt,
    syncState: 'synced',
    lastSyncAt: ackAt,
    syncError: '',
  })
}

export async function markSurveySyncFailed(id: string, at: string, message: string): Promise<void> {
  await db.surveys.update(id, { syncState: 'failed', lastSyncAt: at, syncError: message })
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
}

/* ------------------------- 复壮措施（班组侧） ------------------------- */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 班组侧写入复壮措施。
 * 措施状态为「已完成」时，回写古树的最近复壮日期（仅当本次日期更新时）。
 */
export async function putCrewMeasure(row: Measure): Promise<void> {
  const stamp = nowIso()
  await db.transaction('rw', db.trees, db.measures, async () => {
    await db.measures.put({
      ...row,
      owner: 'crew',
      crewUpdatedAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (!tree) return
    if (tree.lastMeasureDate >= row.date) return
    await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
  })
}

export async function markMeasureSynced(id: string, ackAt: string): Promise<void> {
  await db.measures.update(id, {
    techAckAt: ackAt,
    syncState: 'synced',
    lastSyncAt: ackAt,
    syncError: '',
  })
}

export async function markMeasureSyncFailed(id: string, at: string, message: string): Promise<void> {
  await db.measures.update(id, { syncState: 'failed', lastSyncAt: at, syncError: message })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态（班组侧）；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putCrewMeasure({ ...row, state })
  }
  return list.length
}

/* ------------------- 加固件：班组检查日期 / 技术组周期 ------------------- */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

/** 登记新加固件：共享登记信息一次填好，两侧初值各存一份、默认已同步 */
export async function putSupport(row: Support): Promise<void> {
  const stamp = nowIso()
  await db.supports.put({
    ...row,
    techCheckDate: row.techCheckDate ?? row.lastCheckDate,
    owner: 'crew',
    crewUpdatedAt: row.crewUpdatedAt ?? stamp,
    techAckAt: row.techAckAt ?? stamp,
    syncState: row.syncState ?? 'synced',
    lastSyncAt: row.lastSyncAt ?? stamp,
    syncError: row.syncError ?? '',
    updatedAt: stamp,
    revision: ROW_REVISION,
  })
}

/** 班组侧：只登记现场检查日期，绝不动技术组定的周期；新值待同步 */
export async function markCrewSupportChecked(
  id: string,
  date = today()
): Promise<void> {
  const stamp = nowIso()
  await db.supports.update(id, {
    lastCheckDate: date,
    crewUpdatedAt: stamp,
    syncState: 'pending',
    syncError: '',
    updatedAt: stamp,
  })
}

/** 同步引擎：技术组侧确认检查日期，不回改班组值、不动周期 */
export async function markSupportCheckSynced(id: string, ackAt: string): Promise<void> {
  const current = await db.supports.get(id)
  if (!current) return
  await db.supports.update(id, {
    techCheckDate: current.lastCheckDate,
    techAckAt: ackAt,
    syncState: 'synced',
    lastSyncAt: ackAt,
    syncError: '',
  })
}

export async function markSupportCheckFailed(id: string, at: string, message: string): Promise<void> {
  await db.supports.update(id, { syncState: 'failed', lastSyncAt: at, syncError: message })
}

/** 技术组侧：只调整检查周期，绝不删改班组已登记的现场检查日期 */
export async function setTechSupportCycle(id: string, checkCycleMon: number): Promise<void> {
  const stamp = nowIso()
  await db.supports.update(id, {
    checkCycleMon,
    techAckAt: stamp,
    updatedAt: stamp,
  })
}

/** 对账裁定：以班组检查日期为准，技术组侧确认值对齐班组值 */
export async function resolveSupportCheckToCrew(id: string, at: string): Promise<void> {
  const current = await db.supports.get(id)
  if (!current) return
  await db.supports.update(id, {
    techCheckDate: current.lastCheckDate,
    techAckAt: at,
    syncState: 'synced',
    lastSyncAt: at,
    syncError: '',
  })
}

/** 对账裁定：以技术组确认日期为准（仅落技术组台账，班组现场记录保留不删） */
export async function resolveSupportCheckToTech(id: string, at: string): Promise<void> {
  await db.supports.update(id, {
    techAckAt: at,
    syncState: 'synced',
    lastSyncAt: at,
    syncError: '',
  })
}

export async function removeSupport(id: string): Promise<void> {
  await db.supports.delete(id)
  await db.discrepancies.where('recordId').equals(id).delete()
}

/* ---------------------- 长势复评（技术组侧定级） ---------------------- */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

/** 技术组侧写入长势复评（含定级）；班组现场检查不会走这里，定级不被改写 */
export async function putTechReview(row: Review): Promise<void> {
  const stamp = nowIso()
  await db.reviews.put({
    ...row,
    owner: 'tech',
    techUpdatedAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
  await db.discrepancies.where('recordId').equals(id).delete()
}

/* ------------------------------ 对账差异 ------------------------------ */

export async function listDiscrepancies(): Promise<LedgerDiscrepancy[]> {
  const rows = await db.discrepancies.toArray()
  return rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
    return b.foundAt.localeCompare(a.foundAt)
  })
}

export async function putDiscrepancy(row: LedgerDiscrepancy): Promise<void> {
  await db.discrepancies.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
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
  discrepancies: LedgerDiscrepancy[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, discrepancies] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
    db.discrepancies.toArray(),
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
    discrepancies,
  }
}

/** 用快照覆盖整库（导入存档）；导入后视为两侧台账即快照内状态 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  const stamp = nowIso()
  // 兼容 v1/v2 旧存档：补齐 v3 两侧分账字段（历史数据两边各存一份、视为已同步）
  const surveys = snapshot.surveys.map((row) => ({
    ...row,
    owner: row.owner ?? 'crew',
    crewUpdatedAt: row.crewUpdatedAt ?? row.updatedAt ?? stamp,
    techAckAt: row.techAckAt ?? row.updatedAt ?? stamp,
    syncState: row.syncState ?? 'synced',
    lastSyncAt: row.lastSyncAt ?? stamp,
    syncError: row.syncError ?? '',
    revision: ROW_REVISION,
  }))
  const measures = snapshot.measures.map((row) => ({
    ...row,
    owner: row.owner ?? 'crew',
    crewUpdatedAt: row.crewUpdatedAt ?? row.updatedAt ?? stamp,
    techAckAt: row.techAckAt ?? row.updatedAt ?? stamp,
    syncState: row.syncState ?? 'synced',
    lastSyncAt: row.lastSyncAt ?? stamp,
    syncError: row.syncError ?? '',
    revision: ROW_REVISION,
  }))
  const supports = snapshot.supports.map((row) => ({
    ...row,
    checkCycleMon: typeof row.checkCycleMon === 'number' ? row.checkCycleMon : 12,
    lastCheckDate: row.lastCheckDate ?? '',
    techCheckDate: row.techCheckDate ?? row.lastCheckDate ?? '',
    owner: row.owner ?? 'crew',
    crewUpdatedAt: row.crewUpdatedAt ?? row.updatedAt ?? stamp,
    techAckAt: row.techAckAt ?? row.updatedAt ?? stamp,
    syncState: row.syncState ?? 'synced',
    lastSyncAt: row.lastSyncAt ?? stamp,
    syncError: row.syncError ?? '',
    revision: ROW_REVISION,
  }))
  const reviews = snapshot.reviews.map((row) => ({
    ...row,
    owner: row.owner ?? 'tech',
    techUpdatedAt: row.techUpdatedAt ?? row.updatedAt ?? stamp,
    revision: ROW_REVISION,
  }))

  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.discrepancies, db.meta],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.discrepancies.clear(),
      ])
      await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.surveys.bulkPut(surveys)
      await db.measures.bulkPut(measures)
      await db.supports.bulkPut(supports)
      await db.reviews.bulkPut(reviews)
      await db.discrepancies.bulkPut((snapshot.discrepancies ?? []).map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.meta.bulkPut(
        (Object.keys(META_DEFAULTS) as MetaKey[]).map((key) => ({ key, value: META_DEFAULTS[key] }))
      )
    }
  )
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.discrepancies, db.meta],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.discrepancies.clear(),
      ])
    }
  )
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, discrepancies] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.reviews.count(),
    db.discrepancies.count(),
  ])
  return { trees, surveys, measures, supports, reviews, discrepancies }
}
