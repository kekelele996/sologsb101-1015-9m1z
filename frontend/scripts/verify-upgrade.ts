/**
 * v2 → v3 升级迁移验证：旧库没有任何分账字段，打开后必须
 * 先把历史数据分到两侧（owner / 两侧时间戳 / 同步状态），再启用分账。
 * npx vite-node scripts/verify-upgrade.ts
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { db, initDatabase, listSurveys, listSupports, listReviews } from '../src/utils/db'

let failures = 0
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failures += 1
    console.error(`  ✗ ${msg}`)
  }
}

async function seedV2(): Promise<void> {
  // 用一个独立 Dexie 实例按 v2 结构灌旧格式数据（无 owner / syncState / techCheckDate 等）
  const old = new Dexie('gbheritagetree')
  old.version(2).stores({
    trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
    surveys: 'id, treeId, [treeId+date], date, siteNote',
    measures: 'id, treeId, type, state, date, operator',
    supports: 'id, treeId, type, installDate, lastCheckDate',
    reviews: 'id, treeId, date, vigor, trend',
  })
  await old.table('trees').put({
    id: 't1',
    code: '京-99-9999',
    species: '国槐',
    protectLevel: '一级',
    ageYears: 200,
    location: '测试地点',
    owner: '测试单位',
    lastMeasureDate: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    revision: 2,
  })
  await old.table('surveys').put({
    id: 'sv1',
    treeId: 't1',
    date: '2024-05-01',
    heightM: 10,
    dbhCm: 50,
    crownM: 6,
    leanDeg: 2,
    hollowCount: 0,
    siteNote: '裸土',
    createdAt: '2024-05-01T00:00:00.000Z',
    updatedAt: '2024-05-01T00:00:00.000Z',
    revision: 2,
  })
  await old.table('supports').put({
    id: 'sp1',
    treeId: 't1',
    type: '支撑杆',
    installDate: '2020-01-01',
    checkCycleMon: 18,
    lastCheckDate: '2025-01-01',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    revision: 2,
  })
  await old.table('reviews').put({
    id: 'rv1',
    treeId: 't1',
    date: '2025-06-01',
    vigor: '衰弱',
    trend: '下降',
    conclusion: '测试结论',
    followUp: '测试后续措施',
    createdAt: '2025-06-01T00:00:00.000Z',
    updatedAt: '2025-06-01T00:00:00.000Z',
    revision: 2,
  })
  await old.close()
}

async function main(): Promise<void> {
  if (db.isOpen()) db.close()
  indexedDB.deleteDatabase('gbheritagetree')
  console.log('先构造一个 v2 旧库（无分账字段）')
  await seedV2()

  console.log('用 v3 应用打开（触发 upgrade 迁移）')
  // trees 非空，initDatabase 不会播种；直接打开触发迁移
  await initDatabase()
  // 注意：trees 非空所以不会播种，保留旧数据

  const surveys = await listSurveys()
  const supports = await listSupports()
  const reviews = await listReviews()

  const sv = surveys[0]
  assert(sv.owner === 'crew', '旧树体检查归属班组')
  assert(sv.syncState === 'synced', '旧树体检查迁移后标记为已同步（技术组侧已确认）')
  assert(typeof sv.crewUpdatedAt === 'string' && sv.crewUpdatedAt !== '', '班组侧时间戳已回填')
  assert(typeof sv.techAckAt === 'string' && sv.techAckAt !== '', '技术组确认时间戳已回填')

  const sp = supports[0]
  assert(sp.owner === 'crew', '旧加固件归属补齐')
  assert(sp.checkCycleMon === 18, '技术组周期保留 18')
  assert(sp.lastCheckDate === '2025-01-01', '班组检查日期保留')
  assert(sp.techCheckDate === '2025-01-01', '旧检查日期复制到技术组侧，两侧初始一致不产生差异')
  assert(sp.syncState === 'synced', '旧加固件迁移后已同步')

  const rv = reviews[0]
  assert(rv.owner === 'tech', '旧复评归属技术组')
  assert(typeof rv.techUpdatedAt === 'string' && rv.techUpdatedAt !== '', '技术组定级时间戳已回填')
  assert(rv.vigor === '衰弱' && rv.followUp === '测试后续措施', '定级与后续措施原样保留，不被迁移改写')

  const discrepancies = await db.discrepancies.count()
  assert(discrepancies === 0, '迁移后两侧一致，不产生待裁定差异')

  const enabled = (await db.meta.get('ledgerSplitEnabled'))?.value
  assert(enabled === 'true', '迁移完成后分账才置为启用（先迁移、再启用）')

  if (failures > 0) {
    console.error(`\n${failures} 条断言失败`)
    process.exit(1)
  } else console.log('\nv2→v3 迁移断言全部通过 ✅')
  db.close()
  process.exit(0)
}

void main()
