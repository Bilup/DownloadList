<script setup lang="ts">
import {ref, computed, onMounted} from "vue";
import {PageFileData} from "../../../../type/index.js";
import {fileSizeFormat} from "../../../js/fileSizeFormat.js";
import {dateFormat} from "../../../js/dateFormat.js";
import AButton from "../../buttons/AButton.vue";
import {putNotification} from "../../../js/notification/notification.js";
import FileTypeIcon from "../../FileTypeIcon.vue";
import {
    turboDownload,
    turboSupported,
    formatSpeed,
    probeFile,
    CacheProbe,
    TurboUnsupportedError
} from "../../../js/turboDownload.js";

const props = defineProps<{file:PageFileData}>()

const downloading = ref(false);
const progress = ref(0);
const speed = ref(0);
const finishedChunks = ref(0);
const totalChunks = ref(0);
const showPanel = ref(false);
const threads = ref(4);
const probing = ref(false);
const probe = ref<CacheProbe | null>(null);

const canTurbo = computed(() => turboSupported());
const absoluteUrl = computed(() => new URL(props.file.downloadUrl, window.location.origin).toString());

/** 缓存状态决定建议：未缓存时多线程反而更慢 */
const advice = computed(() => {
    if (!probe.value) return null;
    if (probe.value.cached) {
        return {
            tone: "good",
            text: "文件已在边缘缓存，多线程可直接从边缘取，能突破单连接的延迟瓶颈。"
        };
    }
    return {
        tone: "warn",
        text: "文件尚未进入边缘缓存。首次下载需要把整个文件从源站拉下来，" +
              "此时多个分段会各自触发一次完整回源 —— 多线程反而更慢，建议先用普通下载。"
    };
});

function copyLink(){
  navigator.clipboard.writeText(absoluteUrl.value);
  putNotification({message: "链接已复制", type: "success"});
}

/** 展开面板时探测一次缓存状态 */
async function togglePanel(){
  showPanel.value = !showPanel.value;
  if (showPanel.value && !probe.value && !probing.value) {
    probing.value = true;
    try {
      probe.value = await probeFile(absoluteUrl.value);
    } catch (error) {
      putNotification({message: "无法获取文件信息：" + (error?.message || error), type: "error"});
    } finally {
      probing.value = false;
    }
  }
}

/** 多线程分段下载 */
async function startTurbo(){
  if (downloading.value) return;
  downloading.value = true;
  progress.value = 0;
  speed.value = 0;
  finishedChunks.value = 0;
  totalChunks.value = 0;
  try {
    await turboDownload(absoluteUrl.value, props.file.name, {
      threads: threads.value,
      onProgress: (p) => {
        progress.value = p.total > 0 ? p.done / p.total : 0;
        speed.value = p.speed;
        finishedChunks.value = p.finishedChunks;
        totalChunks.value = p.totalChunks;
      },
      onDone: () => {
        putNotification({message: "下载完成", type: "success"});
      }
    });
  } catch (error) {
    if (error instanceof TurboUnsupportedError) {
      putNotification({message: error.message, type: "error"});
    } else {
      putNotification({message: "下载失败：" + (error?.message || error), type: "error"});
    }
  } finally {
    downloading.value = false;
  }
}

onMounted(() => {
  // 面板首次打开时才探测，避免无谓的请求
});

</script>

<template>
  <div class="down">
    <FileTypeIcon :fileName="props.file.name" :isFolder="false" class="icon"></FileTypeIcon>
    <div class="name">{{props.file.name}}</div>
    <div class="info">{{fileSizeFormat(props.file.size)}} {{dateFormat(props.file.updateTime)}}</div>
    <div v-if="props.file.downloadCorsAllow=='verystrict'" style="margin-top: 1rem;font-size: 0.8rem;margin-bottom: -0.5rem;color: var(--tip-color-error);">由于原站严格限制,请复制链接后粘贴到新标签页下载。</div>
    <div class="buttons">
      <AButton class="button-color-grep1" @click="copyLink()">复制链接</AButton>
      <AButton target="_blank" :href="props.file.downloadUrl" v-if="props.file.downloadCorsAllow!='verystrict'">下载</AButton>
      <button class="mt-btn" @click="togglePanel()" v-if="props.file.downloadCorsAllow!='verystrict'">
        多线程下载
      </button>
    </div>

    <transition name="mt">
      <div class="mt-panel" v-if="showPanel">
        <div class="mt-head">
          <span class="mt-title">多线程下载</span>
          <span class="mt-sub">把文件拆成多段同时拉取</span>
        </div>

        <div class="mt-body">
          <div class="mt-row">
            <span class="mt-label">并发线程</span>
            <div class="mt-threads">
              <button v-for="n in [2,4,8,16]" :key="n"
                      class="mt-thread" :class="{active: threads===n}"
                      @click="threads=n" :disabled="downloading">{{n}}</button>
            </div>
          </div>

          <div class="mt-tip" :class="advice ? advice.tone : 'loading'" v-if="probing">
            正在检测边缘缓存状态…
          </div>
          <div class="mt-tip" :class="advice.tone" v-else-if="advice">
            {{ advice.text }}
          </div>

          <div class="mt-progress" v-if="downloading">
            <div class="mt-bar">
              <div class="mt-fill" :style="{width: (progress*100).toFixed(1)+'%'}"></div>
            </div>
            <div class="mt-stat">
              <span class="mt-pct">{{(progress*100).toFixed(1)}}%</span>
              <span class="mt-speed">{{formatSpeed(speed)}}</span>
              <span class="mt-chunks" v-if="totalChunks>0">分段 {{finishedChunks}}/{{totalChunks}}</span>
            </div>
          </div>

          <div class="mt-actions">
            <button class="mt-go" @click="startTurbo()" :disabled="downloading || probing">
              {{ downloading ? '下载中…' : '开始多线程下载' }}
            </button>
            <span class="mt-note" v-if="!canTurbo">
              当前浏览器不支持流式写盘（需 Chrome / Edge），请用普通下载
            </span>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.buttons{
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  margin-top: 2rem;
  flex-wrap: wrap;
}
.info{
  margin-top: 0.8rem;
  font-size: 0.8rem;
  color: var(--f-color-2);
}
.name{
  font-weight: bolder;
  margin-top: 1.5rem;
  font-size: 1.1rem;
  max-width: 100%;
  word-wrap: break-word;
  text-align: center;
}
.icon{
  width: 5rem;
  color: var(--t-color-1);
}
.down{
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 1rem 0;
}

/* 主按钮：与站点主题蓝一致 */
.mt-btn{
  display: inline-block;
  border-radius: 0.6rem;
  padding: 0.6rem 1rem;
  background-color: var(--t-color-1);
  color: #fff;
  border: none;
  cursor: pointer;
  font-size: inherit;
  transition: opacity 0.2s, transform 0.2s;
}
.mt-btn:hover{
  opacity: 0.86;
  transform: translateY(-1px);
}

/* 面板 */
.mt-panel{
  margin-top: 1.4rem;
  width: min(34rem, 100%);
  border-radius: 0.9rem;
  border: 1px solid var(--main-border-c);
  background-color: var(--mian-box-bgc);
  box-shadow: var(--mian-box-shadow);
  overflow: hidden;
}
.mt-head{
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  padding: 0.85rem 1.1rem;
  background-color: var(--page-bgc);
  border-bottom: 1px solid var(--main-border-c);
}
.mt-title{
  font-weight: 600;
  color: var(--f-color-0);
  font-size: 0.95rem;
}
.mt-sub{
  color: var(--f-color-2);
  font-size: 0.78rem;
}
.mt-body{
  padding: 1.1rem;
}

/* 线程选择 */
.mt-row{
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 0.9rem;
}
.mt-label{
  color: var(--f-color-1);
  font-size: 0.85rem;
}
.mt-threads{
  display: flex;
  gap: 0.35rem;
}
.mt-thread{
  min-width: 2.3rem;
  padding: 0.3rem 0.5rem;
  border-radius: 0.4rem;
  border: 1px solid var(--main-border-c);
  background-color: transparent;
  color: var(--f-color-1);
  cursor: pointer;
  font-size: 0.82rem;
  transition: all 0.15s;
}
.mt-thread:hover:not(:disabled){
  background-color: var(--main-hover-bg);
}
.mt-thread.active{
  background-color: var(--t-color-1);
  border-color: var(--t-color-1);
  color: #fff;
}
.mt-thread:disabled{
  opacity: 0.5;
  cursor: not-allowed;
}

/* 提示条 */
.mt-tip{
  border-radius: 0.5rem;
  padding: 0.65rem 0.8rem;
  font-size: 0.8rem;
  line-height: 1.6;
  margin-bottom: 0.9rem;
}
.mt-tip.good{
  background-color: rgba(76, 156, 76, 0.1);
  color: var(--tip-color-success);
}
.mt-tip.warn{
  background-color: rgba(240, 173, 78, 0.14);
  color: var(--tip-color-warning);
}
.mt-tip.loading{
  background-color: var(--page-bgc);
  color: var(--f-color-2);
}

/* 进度 */
.mt-progress{
  margin-bottom: 1rem;
}
.mt-bar{
  height: 0.4rem;
  border-radius: 0.25rem;
  background-color: var(--page-bgc);
  overflow: hidden;
}
.mt-fill{
  height: 100%;
  border-radius: 0.25rem;
  background: linear-gradient(90deg, var(--t-color-1), #7fd4ff);
  transition: width 0.2s linear;
}
.mt-stat{
  display: flex;
  justify-content: space-between;
  margin-top: 0.5rem;
  font-size: 0.78rem;
  color: var(--f-color-2);
  font-variant-numeric: tabular-nums;
}
.mt-pct{
  color: var(--f-color-0);
  font-weight: 600;
}
.mt-speed{
  color: var(--t-color-1);
  font-weight: 600;
}

/* 行动区 */
.mt-actions{
  display: flex;
  align-items: center;
  gap: 0.8rem;
  flex-wrap: wrap;
}
.mt-go{
  border: none;
  border-radius: 0.5rem;
  padding: 0.55rem 1.3rem;
  background-color: var(--t-color-1);
  color: #fff;
  cursor: pointer;
  font-size: 0.88rem;
  font-weight: 600;
  transition: opacity 0.2s;
}
.mt-go:hover:not(:disabled){
  opacity: 0.86;
}
.mt-go:disabled{
  opacity: 0.55;
  cursor: not-allowed;
}
.mt-note{
  color: var(--f-color-2);
  font-size: 0.76rem;
}

/* 展开动画 */
.mt-enter-active, .mt-leave-active{
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.mt-enter-from, .mt-leave-to{
  opacity: 0;
  transform: translateY(-6px);
}
</style>
