/**
 * 两侧分账的同步与对账引擎（纯本地，模拟「班组 → 技术组」链路）
 *
 * 规则（对应档案管理约定）：
 * 1. 班组新登记的现场记录（树体检查 / 复壮措施 / 加固件检查日期）推给技术组；
 * 2. 班组侧同步失败（离线）后按「本侧重试」，技术组定过的周期 / 定级不再退回；
 * 3. 两侧取值对不上（班组检查日期 ≠ 技术组已确认日期）时，不自动覆盖，
 *    写一条差异到 discrepancies 表，摆到对账页写清编号等人裁定；
 * 4. 裁定后按所选侧对齐并结案，另一侧原值仍保留在记录里可追溯。
 */
import type { Support } from '../types/support'
import type { LedgerDiscrepancy } from '../types/ledger'
import {
  db,
  isSimulateOffline,
  markMeasureSyncFailed,
  markMeasureSynced,
  markSupportCheckFailed,
  markSupportCheckSynced,
  markSurveySyncFailed,
  markSurveySynced,
  putDiscrepancy,
  resolveSupportCheckToCrew,
  resolveSupportCheckToTech,
  setMeta,
} from './db'
import { nowIso, uuid } from './id'

export interface SyncResult {
  /** 本次成功同步条数 */
  pushed: number
  /** 本次失败条数（离线等） */
  failed: number
  /** 新发现的两侧不一致条数 */
  discrepancies: number
  /** 是否处于离线（模拟）状态 */
  offline: boolean
}

/** 是否存在待同步 / 同步失败的班组现场记录 */
export async function hasPendingCrewRecords(): Promise<boolean> {
  const [surveys, measures, supports] = await Promise.all([
    db.surveys.where('syncState').anyOf('pending', 'failed').count(),
    db.measures.where('syncState').anyOf('pending', 'failed').count(),
    db.supports.where('syncState').anyOf('pending', 'failed').count(),
  ])
  return surveys + measures + supports > 0
}

/** 待同步 / 失败的班组记录总数（含加固件检查日期） */
export async function countPendingCrewRecords(): Promise<number> {
  const [surveys, measures, supports] = await Promise.all([
    db.surveys.where('syncState').anyOf('pending', 'failed').count(),
    db.measures.where('syncState').anyOf('pending', 'failed').count(),
    db.supports.where('syncState').anyOf('pending', 'failed').count(),
  ])
  return surveys + measures + supports
}

/** 取加固件对应古树编号（差异页展示用） */
async function treeCodeOf(treeId: string): Promise<string> {
  const tree = await db.trees.get(treeId)
  return tree?.code ?? '（古树已删除）'
}

/** 为同一条加固件登记一条「待裁定」差异（已存在待裁定差异则不重复挂） */
async function openSupportDiscrepancy(support: Support, at: string): Promise<void> {
  const existing = await db.discrepancies
    .where('recordId')
    .equals(support.id)
    .filter((row) => row.status === 'pending' && row.field === '现场检查日期')
    .first()
  if (existing) return
  const row: LedgerDiscrepancy = {
    id: uuid('disc'),
    entity: 'support',
    recordId: support.id,
    treeId: support.treeId,
    treeCode: await treeCodeOf(support.treeId),
    field: '现场检查日期',
    crewValue: support.lastCheckDate || '未记录',
    techValue: support.techCheckDate || '未记录',
    foundAt: at,
    status: 'pending',
    resolvedAt: '',
    note: '',
    createdAt: at,
    updatedAt: at,
    revision: 3,
  }
  await putDiscrepancy(row)
}

/**
 * 推送班组侧台账到技术组（按班组本侧重试）。
 * - 离线（模拟）时：本次待推记录全部置 failed，技术组侧不动（定级 / 周期不退回）；
 * - 在线时：逐条确认班组最新现场值；技术组定过的周期与定级不退回。
 * 两侧「确实分歧」不由同步自动制造，统一由人工「重新对账」（reconcileAll）发现并挂起。
 */
export async function syncCrewToTech(): Promise<SyncResult> {
  const at = nowIso()
  const offline = await isSimulateOffline()

  const surveys = await db.surveys.where('syncState').anyOf('pending', 'failed').toArray()
  const measures = await db.measures.where('syncState').anyOf('pending', 'failed').toArray()
  const supports = await db.supports.where('syncState').anyOf('pending', 'failed').toArray()

  if (offline) {
    const message = '技术组台账暂不可达（离线），已按班组侧保留，稍后可重试。'
    for (const row of surveys) await markSurveySyncFailed(row.id, at, message)
    for (const row of measures) await markMeasureSyncFailed(row.id, at, message)
    for (const row of supports) await markSupportCheckFailed(row.id, at, message)
    return { pushed: 0, failed: surveys.length + measures.length + supports.length, discrepancies: 0, offline: true }
  }

  let pushed = 0

  // 树体检查 / 复壮措施：技术组侧只读，直接确认
  for (const row of surveys) {
    await markSurveySynced(row.id, at)
    pushed += 1
  }
  for (const row of measures) {
    await markMeasureSynced(row.id, at)
    pushed += 1
  }

  // 加固件检查日期：现场检查日期为班组专属事实，技术组侧只做登记确认，
  // 在线推送 / 本侧重试一律确认班组最新值（不回退技术组定的周期与定级）。
  for (const row of supports) {
    await markSupportCheckSynced(row.id, at)
    pushed += 1
  }

  if (pushed > 0) await setMeta('lastCrewSyncAt', at)
  return { pushed, failed: 0, discrepancies: 0, offline: false }
}

/**
 * 全量对账：扫描所有加固件，班组检查日期 ≠ 技术组已确认日期即挂差异。
 * 用于迁移后或人工触发的「重新对账」。
 */
export async function reconcileAll(): Promise<number> {
  const at = nowIso()
  const supports = await db.supports.toArray()
  let opened = 0
  for (const support of supports) {
    if (support.lastCheckDate !== support.techCheckDate) {
      const before = await db.discrepancies
        .where('recordId')
        .equals(support.id)
        .filter((row) => row.status === 'pending')
        .count()
      await openSupportDiscrepancy(support, at)
      const after = await db.discrepancies
        .where('recordId')
        .equals(support.id)
        .filter((row) => row.status === 'pending')
        .count()
      if (after > before) opened += 1
    }
  }
  return opened
}

export interface ResolveResult {
  ok: boolean
  message: string
}

/**
 * 人工裁定一条差异。
 * - support / 现场检查日期：
 *   resolved-crew  以班组检查日期为准，技术组侧确认值对齐班组；
 *   resolved-tech  以技术组确认值为准，班组现场记录保留不删（仅技术组侧落账）。
 */
export async function resolveDiscrepancy(
  discrepancy: LedgerDiscrepancy,
  choice: 'resolved-crew' | 'resolved-tech',
  note = ''
): Promise<ResolveResult> {
  const at = nowIso()
  if (discrepancy.entity === 'support') {
    if (choice === 'resolved-crew') {
      await resolveSupportCheckToCrew(discrepancy.recordId, at)
    } else {
      await resolveSupportCheckToTech(discrepancy.recordId, at)
    }
  }
  // review 定级为技术组专属写入，若历史对账出现定级差异，只能按技术组值结案
  await db.discrepancies.update(discrepancy.id, {
    status: choice,
    resolvedAt: at,
    note: note.trim(),
    updatedAt: at,
  })
  return { ok: true, message: choice === 'resolved-crew' ? '已按班组现场记录结案' : '已按技术组台账结案' }
}

/** 班组侧重试单条同步（同步失败后按本侧重试） */
export async function retryOne(record: { id: string; kind: 'survey' | 'measure' | 'support' }): Promise<SyncResult> {
  // 先确保只重试这一条：离线判断与单条推送
  const offline = await isSimulateOffline()
  const at = nowIso()
  if (offline) {
    const message = '技术组台账暂不可达（离线），已按班组侧保留，稍后可重试。'
    if (record.kind === 'survey') await markSurveySyncFailed(record.id, at, message)
    if (record.kind === 'measure') await markMeasureSyncFailed(record.id, at, message)
    if (record.kind === 'support') await markSupportCheckFailed(record.id, at, message)
    return { pushed: 0, failed: 1, discrepancies: 0, offline: true }
  }

  if (record.kind === 'survey') {
    await markSurveySynced(record.id, at)
    return { pushed: 1, failed: 0, discrepancies: 0, offline: false }
  }
  if (record.kind === 'measure') {
    await markMeasureSynced(record.id, at)
    return { pushed: 1, failed: 0, discrepancies: 0, offline: false }
  }

  const support = await db.supports.get(record.id)
  if (!support) return { pushed: 0, failed: 0, discrepancies: 0, offline: false }
  // 班组检查日期为班组专属事实，在线重试直接确认，不回退技术组周期 / 定级
  await markSupportCheckSynced(support.id, at)
  return { pushed: 1, failed: 0, discrepancies: 0, offline: false }
}
