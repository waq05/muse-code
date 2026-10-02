/**
 * 本机消息评价（赞 / 踩）的存档：键 = `会话:条目`，只落 localStorage。
 *
 * 为什么要单独一个模块：宿主协议里没有「用户对某条回复的评价」这一项，界面能做的
 * 只有如实记在自己这台机器上——存取、「只提示一次」的记忆都收在这里，ChatView 的
 * vote 回调只剩三行。存档坏了就当没点过——不能因为一段历史记录把消息流卡住。
 *
 * @module desktop/renderer/chat/feedback
 */
import { toastOk } from '../components/toast.js'

/** 一条回复的本机评价：只有赞 / 踩两态，再点一次取消。 */
export type Feedback = 'up' | 'down'

/** 本机评价的存档键（localStorage）。 */
const FEEDBACK_KEY = 'dsc.messageFeedback'

/**
 * 读本机评价存档。
 */
export function loadFeedback(): Record<string, Feedback> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, Feedback> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'up' || value === 'down') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** 本机评价只说明一次（第一次点的时候），免得每点一次都弹一条提示。 */
let toldFeedbackOnce = false

/**
 * 落一份评价存档（合并后的全表），第一次评价时弹一次说明。
 * 存不下（本地存储被禁用/写满）也不影响这次会话里的显示。
 */
export function recordFeedback(merged: Record<string, Feedback>): void {
  try {
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(merged))
  } catch {
    // 同上：这只是本机便利，存不进去就算了
  }
  if (!toldFeedbackOnce) {
    toldFeedbackOnce = true
    toastOk('已在本机记下你的评价（宿主还没有评价上传通道）')
  }
}
