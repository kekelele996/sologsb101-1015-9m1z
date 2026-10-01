<script setup lang="ts">
/**
 * <ReconPanel> 两边对账待裁定 + 班组同步发件箱
 * 两边对账对不上的记录先摆到档案页，写清编号等人裁定；
 * 班组侧同步失败的条目在此按本侧重试，技术组定过的不再退回。
 */
import { computed } from 'vue'
import { ElMessage } from 'element-plus'
import { useReconStore } from '@/stores/reconStore'
import { useTreeStore } from '@/stores/treeStore'
import { SIDE_LABEL } from '@/types/side'
import type { ReconItem, ReconResolution } from '@/types/recon'

const reconStore = useReconStore()
const treeStore = useTreeStore()

const treeLabel = computed<Record<string, string>>(() =>
  Object.fromEntries(treeStore.trees.map((tree) => [tree.id, `${tree.code} ${tree.species}`]))
)

const pending = computed<ReconItem[]>(() => reconStore.pendingRecon)
const failedOutbox = computed(() => reconStore.failedOutbox)

const kindLabel: Record<ReconItem['kind'], string> = {
  'grade-mismatch': '定级与现场不一致',
  'weak-without-followup': '衰弱/濒危未填后续措施',
  'field-conflict': '字段冲突',
}

async function handleResolve(item: ReconItem, resolution: ReconResolution): Promise<void> {
  await reconStore.resolve(item.id, resolution)
  ElMessage.success(resolution === 'team' ? `已裁定 ${item.id} 采用班组现场` : `已裁定 ${item.id} 采用技术组定级`)
}

async function handleRetryOutbox(): Promise<void> {
  await reconStore.retryOutbox()
  ElMessage.success(reconStore.lastMessage)
}
</script>

<template>
  <el-card v-if="pending.length > 0 || failedOutbox.length > 0" shadow="never" class="recon-panel">
    <template #header>
      <div class="recon-panel__header">
        <span class="recon-panel__title">两边对账待裁定</span>
        <el-tag type="warning" effect="dark">{{ pending.length }} 条待裁定</el-tag>
        <el-tag v-if="failedOutbox.length > 0" type="danger" effect="dark">
          班组同步失败 {{ failedOutbox.length }} 条
        </el-tag>
      </div>
    </template>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="recon-panel__tip"
      title="班组管树体检查、复壮措施与加固件现场检查日期；技术组管检查周期与长势复评。两边各写各的，对不上的摆到这里写清编号等人裁定。"
    />

    <div v-for="item in pending" :key="item.id" class="recon-item">
      <div class="recon-item__head">
        <el-tag size="small" type="info" effect="plain">编号 {{ item.id }}</el-tag>
        <el-tag size="small" type="warning" effect="plain">{{ kindLabel[item.kind] }}</el-tag>
        <span class="recon-item__tree">{{ treeLabel[item.treeId] ?? '（古树已删除）' }}</span>
      </div>
      <p class="recon-item__reason">{{ item.reason }}</p>
      <div class="recon-item__sides">
        <div class="recon-item__side">
          <span class="recon-item__side-label is-team">{{ SIDE_LABEL.team }}侧</span>
          <span>{{ item.teamValue }}</span>
        </div>
        <div class="recon-item__side">
          <span class="recon-item__side-label is-tech">{{ SIDE_LABEL.tech }}侧</span>
          <span>{{ item.techValue }}</span>
        </div>
      </div>
      <div class="recon-item__actions">
        <el-button size="small" type="primary" plain @click="handleResolve(item, 'tech')">
          采用技术组定级
        </el-button>
        <el-button size="small" type="success" plain @click="handleResolve(item, 'team')">
          采用班组现场
        </el-button>
      </div>
    </div>

    <div v-if="failedOutbox.length > 0" class="outbox">
      <div class="outbox__head">
        <span class="outbox__title">班组同步发件箱（失败后按本侧重试）</span>
        <el-button size="small" type="danger" plain @click="handleRetryOutbox">按本侧重试</el-button>
      </div>
      <div v-for="item in failedOutbox" :key="item.id" class="outbox__item">
        <el-tag size="small" type="danger" effect="plain">{{ item.id }}</el-tag>
        <span class="outbox__desc">{{ item.table }} · {{ item.recordId }} · {{ item.error }}</span>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.recon-panel {
  margin-bottom: 14px;
  border-left: 4px solid #d68910;
}

.recon-panel__header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.recon-panel__title {
  font-size: 15px;
  font-weight: 600;
  color: #2f2a24;
}

.recon-panel__tip {
  margin-bottom: 12px;
}

.recon-item {
  padding: 12px;
  margin-bottom: 10px;
  background: #fbfaf6;
  border: 1px solid #ece5d8;
  border-radius: 10px;
}

.recon-item__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.recon-item__tree {
  font-size: 13px;
  font-weight: 600;
  color: #2f2a24;
}

.recon-item__reason {
  margin: 0 0 8px;
  font-size: 13px;
  color: #6b6257;
  line-height: 1.6;
}

.recon-item__sides {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.recon-item__side {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #2f2a24;
}

.recon-item__side-label {
  flex: none;
  padding: 1px 8px;
  border-radius: 6px;
  font-size: 12px;
  color: #ffffff;
}

.recon-item__side-label.is-team {
  background: #3f6b3a;
}

.recon-item__side-label.is-tech {
  background: #4a6fa5;
}

.recon-item__actions {
  display: flex;
  gap: 8px;
}

.outbox {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed #d8cfbe;
}

.outbox__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.outbox__title {
  font-size: 13px;
  font-weight: 600;
  color: #c0392b;
}

.outbox__item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #6b6257;
  margin-bottom: 4px;
}
</style>
