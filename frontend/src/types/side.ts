/**
 * 两边归属（班组 / 技术组）
 * 现场记录归班组，检查周期与长势复评归技术组；字段级归属见 utils/sync.ts。
 * 两边改同一棵树时按字段归属各写各的，不互相盖掉。
 */

/** 班组（现场侧）与技术组（定级侧） */
export type Side = 'team' | 'tech'

export const SIDE_OPTIONS: Side[] = ['team', 'tech']

export const SIDE_LABEL: Record<Side, string> = {
  team: '班组',
  tech: '技术组',
}

export const SIDE_DESC: Record<Side, string> = {
  team: '管树体检查、复壮措施与加固件现场检查日期',
  tech: '管检查周期与长势复评定级',
}
