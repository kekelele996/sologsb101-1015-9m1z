/**
 * 两边同步与对账引擎
 *
 * 归属拆分：
 * - 班组（team）：surveys / measures 全部字段，supports.lastCheckDate（现场检查日期）。
 * - 技术组（tech）：reviews 全部字段（长势复评定级），supports.checkCycleMon（检查周期）。
 * - 其余为共享字段（如古树编号、加固件类型 / 安装日期）。
 *
 * 关键保证：
 * 1. 技术组定过的复评定级不能被班组新做的检查改写 —— 班组写操作只写本方字段，
 *    不碰 reviews 与 supports.checkCycleMon。
 * 2. 班组已登记的现场记录不能因为技术组调整周期就消失 —— 技术组写操作同样只写本方字段。
 * 3. 班组侧同步失败后按本侧重试，重试只重放本方字段，不退回技术组已定字段。
 * 4. 两边对账对不上的记录生成 ReconItem，摆到档案页写清编号等人裁定。
 */
import type { Table } from 'dexie'
import type { Side } from '../types/side'
import type { OutboxItem, ReconItem, ReconResolution } from '../types/recon'
import { VIGOR_NEED_FOLLOW_UP } from '../types/review'
import { db } from './db'
import { hollowRisk, leanLevel, LEAN_DANGER_DEG } from './dimension'
import { nowIso, uuid } from './id'

/** 各表业务字段归属：surveys / measures 归班组，reviews 归技术组 */
const TABLE_SIDE: Partial<Record<string, Side>> = {
  surveys: 'team',
  measures: 'team',
  reviews: 'tech',
}

/** supports 按字段归属：检查周期归技术组，现场检查日期归班组 */
const SUPPORT_FIELD_SIDE: Record<string, Side> = {
  checkCycleMon: 'tech',
  lastCheckDate: 'team',
}

/** 取字段归属方；共享字段（id / treeId / 类型 / 安装日期等）返回 'shared' */
export function fieldOwner(table: string, field: string): Side | 'shared' {
  if (table === 'supports') {
    if (field in SUPPORT_FIELD_SIDE) return SUPPORT_FIELD_SIDE[field]
    return 'shared'
  }
  return TABLE_SIDE[table] ?? 'shared'
}

/** 当前角色是否可写该字段（共享字段两边都可写） */
export function canWrite(table: string, field: string, role: Side): boolean {
  const owner = fieldOwner(table, field)
  return owner === 'shared' || owner === role
}

/** 从 patch 中过滤出当前角色可写的字段（只写本方字段，不盖对方） */
export function filterWritableFields(table: string, patch: Record<string, unknown>, role: Side): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'createdAt') {
      result[key] = value
      continue
    }
    if (canWrite(table, key, role)) result[key] = value
  }
  return result
}

function tableOf(name: string): Table {
  return (db as unknown as Record<string, Table>)[name] as Table
}

export interface SyncResult {
  ok: boolean
  /** 是否因技术组已更新而冲突（班组侧同步失败） */
  conflict: boolean
  /** 实际写入的本方字段 */
  applied: Record<string, unknown>
  outboxId?: string
  error?: string
}

async function enqueueOutbox(
  item: Omit<OutboxItem, 'id' | 'createdAt' | 'lastAttemptAt' | 'attempts' | 'side'> & { attempts?: number }
): Promise<OutboxItem> {
  const now = nowIso()
  const row: OutboxItem = {
    id: uuid('outbox'),
    side: 'team',
    table: item.table,
    recordId: item.recordId,
    op: item.op,
    patch: item.patch,
    baseUpdatedAt: item.baseUpdatedAt,
    status: item.status,
    error: item.error,
    attempts: item.attempts ?? 1,
    createdAt: now,
    lastAttemptAt: now,
  }
  await db.sync_outbox.put(row)
  return row
}

/**
 * 班组侧字段级写入。
 * - 只写班组归属字段（技术组字段被过滤，绝不退回）。
 * - 若提供 baseUpdatedAt 且技术组在此之后改过该记录，则判定冲突，
 *   同步失败并挂入发件箱，等待「按本侧重试」。
 */
export async function applyTeamPatch(
  table: string,
  recordId: string,
  patch: Record<string, unknown>,
  baseUpdatedAt?: string
): Promise<SyncResult> {
  const writable = filterWritableFields(table, patch, 'team')
  if (baseUpdatedAt) {
    const rec = await tableOf(table).get(recordId)
    if (rec && typeof rec.updatedAt === 'string' && rec.updatedAt > baseUpdatedAt) {
      const ob = await enqueueOutbox({
        table,
        recordId,
        op: 'patch',
        patch: writable,
        baseUpdatedAt,
        status: 'failed',
        error: '技术组已更新该记录，按本侧重试（不会退回技术组已定字段）',
      })
      return { ok: false, conflict: true, applied: {}, outboxId: ob.id, error: ob.error }
    }
  }
  try {
    await tableOf(table).update(recordId, { ...writable, updatedAt: nowIso() })
    return { ok: true, conflict: false, applied: writable }
  } catch (err) {
    const message = err instanceof Error ? err.message : '班组侧同步失败'
    const ob = await enqueueOutbox({
      table,
      recordId,
      op: 'patch',
      patch: writable,
      baseUpdatedAt: baseUpdatedAt ?? '',
      status: 'failed',
      error: message,
    })
    return { ok: false, conflict: false, applied: {}, outboxId: ob.id, error: message }
  }
}

/** 技术组侧字段级写入：只写技术组归属字段，班组现场记录不被覆盖 */
export async function applyTechPatch(
  table: string,
  recordId: string,
  patch: Record<string, unknown>
): Promise<SyncResult> {
  const writable = filterWritableFields(table, patch, 'tech')
  await tableOf(table).update(recordId, { ...writable, updatedAt: nowIso() })
  return { ok: true, conflict: false, applied: writable }
}

/**
 * 班组侧同步失败后按本侧重试。
 * 只重放本方字段（filterWritableFields），不带 baseUpdatedAt 强制应用，
 * 因此技术组已定字段不会被退回。
 */
export async function retryTeamOutbox(): Promise<number> {
  const items = await db.sync_outbox.where('status').anyOf('pending', 'failed').toArray()
  let retried = 0
  for (const item of items) {
    const writable = filterWritableFields(item.table, item.patch, 'team')
    await tableOf(item.table).update(item.recordId, { ...writable, updatedAt: nowIso() })
    await db.sync_outbox.delete(item.id)
    retried += 1
  }
  return retried
}

/* ------------------------------ 两边对账 ------------------------------ */

function dangerDescription(leanDeg: number, hollowCount: number): string {
  const parts: string[] = []
  if (leanLevel(leanDeg) === 'danger') parts.push(`倾斜 ${leanDeg}°（超过 ${LEAN_DANGER_DEG}° 警戒线）`)
  if (hollowRisk(hollowCount).level === 'danger') parts.push(`空洞 ${hollowCount} 处（高风险）`)
  return parts.join('；')
}

/**
 * 两边对账：扫描班组现场记录与技术组复评定级，把对不上的条目写入 recon 表。
 * 幂等：id 由类型 + 古树决定，resolved 条目不重开。
 * 返回本次待裁定条目数。
 */
export async function reconcile(): Promise<number> {
  const [trees, surveys, , , reviews] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
  ])

  const pending: ReconItem[] = []
  for (const tree of trees) {
    const treeSurveys = surveys
      .filter((row) => row.treeId === tree.id)
      .sort((a, b) => a.date.localeCompare(b.date))
    const treeReviews = reviews
      .filter((row) => row.treeId === tree.id)
      .sort((a, b) => a.date.localeCompare(b.date))
    const latestSurvey = treeSurveys.length > 0 ? treeSurveys[treeSurveys.length - 1] : null
    const latestReview = treeReviews.length > 0 ? treeReviews[treeReviews.length - 1] : null

    // 班组现场判定危险，但技术组最近复评定级未体现 → 定级不被检查改写，挂起等人裁定
    if (latestSurvey && latestReview) {
      const danger =
        leanLevel(latestSurvey.leanDeg) === 'danger' || hollowRisk(latestSurvey.hollowCount).level === 'danger'
      const reviewNotWeak = !VIGOR_NEED_FOLLOW_UP.includes(latestReview.vigor)
      if (danger && reviewNotWeak) {
        const teamValue = dangerDescription(latestSurvey.leanDeg, latestSurvey.hollowCount)
        pending.push({
          id: `recon-grade-${tree.id}`,
          kind: 'grade-mismatch',
          treeId: tree.id,
          targetTable: 'reviews',
          targetId: latestReview.id,
          field: 'vigor',
          reason: '班组现场检查判定危险，但技术组最近复评定级未体现；定级不被检查改写，待裁定是否调整。',
          teamValue: `现场：${teamValue}`,
          techValue: `复评：${latestReview.vigor}（${latestReview.trend}）`,
          status: 'pending',
          createdAt: nowIso(),
        })
      }
    }

    // 技术组定级衰弱 / 濒危却未填后续措施 → 待补填裁定
    if (latestReview && VIGOR_NEED_FOLLOW_UP.includes(latestReview.vigor) && latestReview.followUp.trim() === '') {
      pending.push({
        id: `recon-followup-${tree.id}`,
        kind: 'weak-without-followup',
        treeId: tree.id,
        targetTable: 'reviews',
        targetId: latestReview.id,
        field: 'followUp',
        reason: '技术组定级衰弱 / 濒危但未填写后续措施，待补填或裁定。',
        teamValue: '—',
        techValue: `复评：${latestReview.vigor}（${latestReview.date}）`,
        status: 'pending',
        createdAt: nowIso(),
      })
    }
  }

  for (const item of pending) {
    const existing = await db.recon.get(item.id)
    if (existing && existing.status === 'resolved') continue
    await db.recon.put(item)
  }
  return pending.length
}

/** 裁定待条目：采用班组现场（置 needsReReview 请技术组复评）或采用技术组定级（维持不改） */
export async function resolveReconItem(id: string, resolution: ReconResolution): Promise<void> {
  const item = await db.recon.get(id)
  if (!item) return
  if (item.kind === 'grade-mismatch' && resolution === 'team') {
    await db.trees.update(item.treeId, { needsReReview: true, updatedAt: nowIso() })
  }
  await db.recon.update(id, { status: 'resolved', resolution, resolvedAt: nowIso() })
}
