/**
 * 两侧分账（Ledger）归属与同步模型
 *
 * 一份古树档案原来把「现场记录」和「复评定级」挤在同一张表同一行，
 * 养护班组与区技术组改到同一棵树会互相覆盖。拆账后按字段归属：
 *
 * - 班组侧（crew）：树体检查、复壮措施、加固件「现场检查日期」
 * - 技术组侧（tech）：加固件「检查周期」、长势复评（含长势定级）
 *
 * 两侧各持一份台账值，现场记录只从班组写入，定级 / 周期只从技术组写入，
 * 任一侧都不会整行覆盖另一侧。对不上的差异进 `discrepancies` 表，
 * 摆到对账页写清编号等人裁定。
 *
 * 字段为扁平结构（直接铺在各业务行上），与 Dexie 索引和写入风格保持一致。
 */

/** 台账归属方 */
export type LedgerSide = 'crew' | 'tech'

/** 记录归属（legacy = 首启迁移前尚未分到两侧的历史数据） */
export type LedgerOwner = LedgerSide | 'legacy'

export const LEDGER_SIDES: LedgerSide[] = ['crew', 'tech']

export const LEDGER_SIDE_LABEL: Record<LedgerSide, string> = {
  crew: '养护班组',
  tech: '区技术组',
}

/**
 * 同步方向固定为「班组 → 技术组」：
 * 班组新登记的现场记录推给技术组对账；技术组定过的周期 / 定级不回退。
 */
export type SyncDirection = 'crew-to-tech'

export const SYNC_DIRECTION_LABEL: Record<SyncDirection, string> = {
  'crew-to-tech': '班组 → 技术组',
}

/** 同步状态机：待同步 → 同步中 → 已同步 / 失败（失败后按班组本侧重试） */
export type SyncState = 'pending' | 'syncing' | 'synced' | 'failed'

export const SYNC_STATE_LABEL: Record<SyncState, string> = {
  pending: '待同步',
  syncing: '同步中',
  synced: '已同步',
  failed: '同步失败',
}

/**
 * 班组侧记录（树体检查 / 复壮措施 / 加固件现场检查）的分账与同步字段。
 * 这些字段直接铺在业务行上，这里仅作类型分组。
 */
export interface CrewLedgerFields {
  /** 归属方（启用分账后，班组记录恒为 crew） */
  owner: LedgerOwner
  /** 班组侧最后写入时间 */
  crewUpdatedAt: string
  /** 技术组侧最后确认（收到）该记录的时间 */
  techAckAt: string
  syncState: SyncState
  /** 最近一次同步尝试时间 */
  lastSyncAt: string
  /** 同步失败原因（成功后清空） */
  syncError: string
}

/**
 * 技术组侧记录（长势复评）的分账字段。
 * 定级只由技术组写入，班组新做的现场检查不会改写本侧定级。
 */
export interface TechLedgerFields {
  owner: LedgerOwner
  /** 技术组侧最后写入（定级）时间 */
  techUpdatedAt: string
}

/** 差异涉及的业务表：加固件两侧都动手，复评定级技术组专属 */
export type DiscrepancyEntity = 'support' | 'review'

/** 差异裁定结果 */
export type DiscrepancyStatus = 'pending' | 'resolved-crew' | 'resolved-tech'

export const DISCREPANCY_STATUS_LABEL: Record<DiscrepancyStatus, string> = {
  pending: '待人裁定',
  'resolved-crew': '已按班组',
  'resolved-tech': '已按技术组',
}

/**
 * 两侧台账对账不一致的差异条目（摆到档案页等人裁定）。
 * 写清古树编号 / 记录 id / 字段 / 两侧取值，裁定前两侧原值都保留不删。
 */
export interface LedgerDiscrepancy {
  id: string
  entity: DiscrepancyEntity
  /** 业务记录 id（加固件 / 复评记录主键） */
  recordId: string
  treeId: string
  /** 古树编号，如 京-01-0007，便于档案页直接定位 */
  treeCode: string
  /** 对不上的字段名，如「现场检查日期」「长势定级」 */
  field: string
  /** 班组侧取值（快照） */
  crewValue: string
  /** 技术组侧取值（快照） */
  techValue: string
  foundAt: string
  status: DiscrepancyStatus
  resolvedAt: string
  /** 裁定备注 */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** key/value 元信息表的键 */
export type MetaKey = 'ledgerSplitEnabled' | 'simulateOffline' | 'lastCrewSyncAt'
