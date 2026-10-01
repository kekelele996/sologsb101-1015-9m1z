/**
 * 树体检查状态管理（Pinia）—— 养护班组侧
 * 班组登记树体检查（现场记录），新记录默认「待同步」到技术组；
 * 技术组侧不写树体检查，因此班组记录不会被定级 / 周期调整覆盖。
 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Survey, SurveyDraft } from '../types/survey'
import { db, initDatabase, putCrewSurvey, removeSurvey } from '../utils/db'
import { nowIso, uuid } from '../utils/id'

export const useSurveyStore = defineStore('survey', () => {
  const lastMessage = ref('')
  const revision = ref(0)

  async function init(): Promise<void> {
    await initDatabase()
    revision.value += 1
  }

  /** 班组新增树体检查：归属班组、默认待同步 */
  async function createSurvey(draft: SurveyDraft): Promise<Survey> {
    const stamp = nowIso()
    const row: Survey = {
      id: uuid('survey'),
      treeId: draft.treeId,
      date: draft.date,
      heightM: draft.heightM,
      dbhCm: draft.dbhCm,
      crownM: draft.crownM,
      leanDeg: draft.leanDeg,
      hollowCount: draft.hollowCount,
      siteNote: draft.siteNote,
      owner: 'crew',
      crewUpdatedAt: stamp,
      techAckAt: '',
      syncState: 'pending',
      lastSyncAt: '',
      syncError: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    }
    await putCrewSurvey(row)
    revision.value += 1
    lastMessage.value = `已登记 ${row.date} 树体检查，等待同步到技术组台账`
    return row
  }

  /** 班组编辑树体检查：只改现场字段，改后重新待同步 */
  async function updateSurvey(surveyId: string, draft: SurveyDraft): Promise<void> {
    const existing = await db.surveys.get(surveyId)
    if (!existing) return
    const stamp = nowIso()
    await putCrewSurvey({
      ...existing,
      treeId: draft.treeId,
      date: draft.date,
      heightM: draft.heightM,
      dbhCm: draft.dbhCm,
      crownM: draft.crownM,
      leanDeg: draft.leanDeg,
      hollowCount: draft.hollowCount,
      siteNote: draft.siteNote,
      // 编辑后技术组需重新确认
      syncState: 'pending',
      syncError: '',
      crewUpdatedAt: stamp,
    })
    revision.value += 1
    lastMessage.value = '树体检查已更新，等待重新同步到技术组台账'
  }

  async function deleteSurvey(surveyId: string): Promise<void> {
    await removeSurvey(surveyId)
    revision.value += 1
  }

  return { lastMessage, revision, init, createSurvey, updateSurvey, deleteSurvey }
})
