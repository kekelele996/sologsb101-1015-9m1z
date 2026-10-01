/**
 * 加固件（Support）—— 两侧分账的混合记录
 * 支撑杆、拉纤、避雷设施，按检查周期自动提示超期未检查。
 *
 * 字段按归属拆开，两侧改同一棵树也不会互相盖掉：
 * - 班组侧：lastCheckDate 现场检查日期（「登记本次检查」只写班组侧）
 * - 技术组侧：checkCycleMon 检查周期（技术组台账里的周期）
 * - 共享登记信息：type / installDate（登记时一次填好，两侧只读）
 *
 * 班组新登记的检查日期走「班组 → 技术组」同步：
 * - techCheckDate 为技术组台账已确认的检查日期；
 * - 班组侧同步失败（离线）后按本侧重试，技术组定过的周期不退回；
 * - 班组检查日期与技术组已确认值对不上时挂差异到对账页等人裁定。
 */
import type { LedgerOwner, SyncState } from './ledger'

/** 加固件类型 */
export type SupportType = '支撑杆' | '拉纤' | '避雷'

export const SUPPORT_TYPE_OPTIONS: SupportType[] = ['支撑杆', '拉纤', '避雷']

export interface Support {
  id: string
  /** 所属古树 */
  treeId: string
  /** 类型（共享登记信息） */
  type: SupportType
  /** 安装日期 YYYY-MM-DD（共享登记信息） */
  installDate: string

  /* ---- 技术组侧：检查周期 ---- */
  /** 检查周期（月）—— 技术组定，班组只读 */
  checkCycleMon: number

  /* ---- 班组侧：现场检查日期 ---- */
  /** 最近检查日期 YYYY-MM-DD —— 班组登记，技术组不可改写 */
  lastCheckDate: string

  /* ---- 班组 → 技术组：检查日期对账 ---- */
  /** 技术组台账已确认的检查日期；与 lastCheckDate 不一致即对账不上 */
  techCheckDate: string
  owner: LedgerOwner
  /** 班组侧最后写入时间 */
  crewUpdatedAt: string
  /** 技术组侧最后确认时间 */
  techAckAt: string
  syncState: SyncState
  lastSyncAt: string
  syncError: string

  createdAt: string
  updatedAt: string
  revision: number
}

/** 登记加固件的表单草稿（共享登记信息 + 两侧初值） */
export interface SupportDraft {
  treeId: string
  type: SupportType
  installDate: string
  /** 技术组定的检查周期 */
  checkCycleMon: number
  /** 班组登记的最近检查日期 */
  lastCheckDate: string
}

/** 技术组调整检查周期的草稿（只动技术组字段） */
export interface SupportCycleDraft {
  checkCycleMon: number
}

/** 班组登记现场检查的草稿（只动班组字段） */
export interface SupportCheckDraft {
  lastCheckDate: string
}
