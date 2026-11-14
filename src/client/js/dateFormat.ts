
/** 展示用的固定时区偏移（毫秒）。UTC+8 */
const DISPLAY_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 将时间格式化为 yyyy-mm-dd hh:mm
 *
 * 固定按 UTC+8（北京时间）显示，**不能用本地时区方法**
 * （getFullYear / getMonth / getDate / getHours / getMinutes）：
 *
 *   SSR 在构建机上执行，客户端在用户机器上执行，两边时区不同，
 *   同一时间戳会渲染出不同的字符串 → Vue 报
 *   “Hydration completed but contains mismatches”，
 *   而且用户会看到时间在页面加载后突然跳一次。
 *
 * 固定偏移后两边结果完全一致。
 * */
export function dateFormat(dateNumber: number|undefined): string {
    if(!dateNumber){
        return '未知';
    }
    const date = new Date(dateNumber + DISPLAY_OFFSET_MS);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
    const minute = String(date.getUTCMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
}
