/**
 * 对账待裁定与班组同步发件箱
 * 两边对账对不上的记录先摆到档案页，写清编号等人裁定；
 * 班组侧同步失败后按本侧重试，技术组定过的不再退回。
 */
import type { Side } from './side'

/** 待裁定条目状态 */
export type ReconStatus = 'pending' | 'resolved'

/** 裁定结果：采用班组现场 / 采用技术组定级 */
export type ReconResolution = 'team' | 'tech'

/** 对账不一致类型 */
export type ReconKind =
  | 'grade-mismatch' // 班组现场判定危险，但技术组最近复评定级未体现
  | 'weak-without-followup' // 技术组定级衰弱 / 濒危却未填后续措施
  | 'field-conflict' // 同一字段两边各写了一份，值不一致

export interface ReconItem {
  id: string
  kind: ReconKind
  /** 所属古树 */
  treeId: string
  /** 争议记录所在表 */
  targetTable: 'surveys' | 'measures' | 'supports' | 'reviews'
  /** 争议记录 id */
  targetId: string
  /** 争议字段 */
  field: string
  /** 对账说明（为什么对不上） */
  reason: string
  /** 班组侧的值（展示用） */
  teamValue: string
  /** 技术组侧的值（展示用） */
  techValue: string
  status: ReconStatus
  resolution?: ReconResolution
  createdAt: string
  resolvedAt?: string
}

/** 班组同步发件箱条目（同步失败后按本侧重试，不退回技术组已定字段） */
export interface OutboxItem {
  id: string
  /** 发起同步的一侧（始终为班组） */
  side: Side
  table: string
  recordId: string
  op: 'put' | 'patch' | 'delete'
  /** 待写入的本方字段（已按归属过滤，不含技术组字段） */
  patch: Record<string, unknown>
  /** 班组读到的记录 updatedAt；若技术组在此之后改过，则判定为冲突 */
  baseUpdatedAt: string
  status: 'pending' | 'failed' | 'synced'
  error: string
  attempts: number
  createdAt: string
  lastAttemptAt: string
}
