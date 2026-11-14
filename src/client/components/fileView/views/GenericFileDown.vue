<script setup lang="ts">
import {ref, computed} from "vue";
import {PageFileData} from "../../../../type/index.js";
import {fileSizeFormat} from "../../../js/fileSizeFormat.js";
import {dateFormat} from "../../../js/dateFormat.js";
import AButton from "../../buttons/AButton.vue";
import {putNotification} from "../../../js/notification/notification.js";
import FileTypeIcon from "../../FileTypeIcon.vue";
import {
    turboDownload,
    turboSupported,
    buildAria2Command,
    formatSpeed,
    TurboUnsupportedError
} from "../../../js/turboDownload.js";

const props = defineProps<{file:PageFileData}>()

const downloading = ref(false);
const progress = ref(0);
const speed = ref(0);
const finishedChunks = ref(0);
const totalChunks = ref(0);
const showPanel = ref(false);

const canTurbo = computed(() => turboSupported());
const absoluteUrl = computed(() => new URL(props.file.downloadUrl, window.location.origin).toString());

function copyLink(){
  navigator.clipboard.writeText(absoluteUrl.value);
  putNotification({message: "链接已复制", type: "success"});
}

function copyAria2(){
  const cmd = buildAria2Command(absoluteUrl.value, props.file.name);
  navigator.clipboard.writeText(cmd);
  putNotification({message: "aria2 命令已复制，粘贴到 Motrix / aria2 即可多线程下载", type: "success"});
}

/** 直接用普通方式下载（浏览器原生单连接） */
function normalDownload(){
  window.open(absoluteUrl.value, "_blank");
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
      threads: 8,
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
      <AButton class="button-color-grep2 turbo" @click="showPanel=!showPanel" v-if="props.file.downloadCorsAllow!='verystrict'">下载速递</AButton>
    </div>

    <div class="turbo-panel" v-if="showPanel">
      <div class="turbo-title">多线程分段下载</div>

      <div class="turbo-desc" v-if="canTurbo">
        把文件拆成 8 段并发拉取，速度取决于你的带宽与到 Cloudflare 边缘的链路。
        文件越大、线程越多，提升越明显。
      </div>
      <div class="turbo-desc" v-else>
        当前浏览器不支持流式写盘（需要 Chrome / Edge）。
        你仍可复制 aria2 命令，在 Motrix、aria2 等客户端里多线程下载。
      </div>

      <div class="turbo-actions">
        <AButton class="button-color-grep2" @click="startTurbo()" v-if="canTurbo">开始加速下载</AButton>
        <AButton class="button-color-grep1" @click="copyAria2()">复制 aria2 命令</AButton>
      </div>

      <div class="turbo-progress" v-if="downloading">
        <div class="bar">
          <div class="fill" :style="{width: (progress*100).toFixed(1)+'%'}"></div>
        </div>
        <div class="turbo-stat">
          <span>{{(progress*100).toFixed(1)}}%</span>
          <span>{{formatSpeed(speed)}}</span>
          <span v-if="totalChunks>0">分段 {{finishedChunks}}/{{totalChunks}}</span>
        </div>
      </div>

      <div class="turbo-hint" v-if="!canTurbo">
        <code>{{ buildAria2Command(absoluteUrl, props.file.name) }}</code>
      </div>
    </div>
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
.turbo-panel{
  margin-top: 1.2rem;
  width: min(38rem, 100%);
  padding: 1rem 1.2rem;
  border-radius: 0.8rem;
  border: 1px solid var(--f-color-2);
  background-color: var(--f-color-1);
  font-size: 0.85rem;
  color: var(--f-color-2);
}
.turbo-title{
  font-weight: bolder;
  color: var(--f-color-1);
  margin-bottom: 0.5rem;
}
.turbo-desc{
  line-height: 1.6;
  margin-bottom: 0.9rem;
}
.turbo-actions{
  display: flex;
  gap: 0.8rem;
  flex-wrap: wrap;
  justify-content: center;
}
.turbo-progress{
  margin-top: 1rem;
}
.bar{
  height: 0.45rem;
  border-radius: 0.3rem;
  background-color: var(--f-color-2);
  overflow: hidden;
}
.fill{
  height: 100%;
  background-color: var(--t-color-1);
  transition: width 0.2s linear;
}
.turbo-stat{
  display: flex;
  justify-content: space-between;
  margin-top: 0.45rem;
  font-size: 0.8rem;
}
.turbo-hint{
  margin-top: 1rem;
  padding: 0.7rem;
  border-radius: 0.5rem;
  background-color: var(--f-color-2);
  word-break: break-all;
  line-height: 1.5;
}
.turbo-hint code{
  font-size: 0.75rem;
  color: var(--f-color-1);
}
</style>
