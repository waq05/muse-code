/**
 * 任务完成的提示音库：14 种音色全部用 Web Audio 现场合成，仓库里没有任何音频资产。
 * 参数表移植自 hermes-agent 桌面端（apps/desktop/src/lib/completion-sound.ts，Apache-2.0，
 * Nous Research）——用户点名「抄他们的提示音效」，合成参数原样保留，音名换成中文。
 *
 * 信号链：每条 voice（带包络的振荡器/噪声）→ master(0.48) → 低通 3800Hz →
 * 干声(0.88) + 卷积混响湿声(0.34) → 输出。混响脉冲是启动后首次播放时生成的
 * 1.6 秒指数衰减白噪声，生成一次就缓存，每次播放用完即弃。
 *
 * @module desktop/renderer/completion-sound
 */

/** 线性起音进指数衰减的振荡器 voice：尾巴平滑，不会像直接拉到 0 那样「咔」一声。 */
function voice(ac: AudioContext, master: GainNode, t0: number, spec: ToneSpec): void {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const peak = spec.gain ?? 0.5
  const attack = spec.attack ?? 0.006
  const end = start + spec.dur

  osc.type = spec.type ?? 'sine'
  osc.frequency.setValueAtTime(spec.freq, start)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), start + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(env)
  env.connect(master)
  osc.start(start)
  osc.stop(end + 0.02)
}

/** 软拨弦：短促三角波起音，频率向上滑一点再开花。 */
function pluckVoice(ac: AudioContext, master: GainNode, t0: number, spec: PluckSpec): void {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const attack = spec.attack ?? 0.004
  const glide = spec.glide ?? 0.16
  const end = start + spec.decay

  osc.type = 'triangle'
  osc.frequency.setValueAtTime(spec.freqFrom, start)
  osc.frequency.exponentialRampToValueAtTime(spec.freqTo, start + glide)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(env)
  env.connect(master)
  osc.start(start)
  osc.stop(end + 0.02)
}

/** 缓起延音的和声泛音——拨弦之后那截余韵。 */
function bloomVoice(ac: AudioContext, master: GainNode, t0: number, spec: BloomSpec): void {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const hold = spec.hold ?? 0.08
  const end = start + spec.attack + hold + spec.decay

  osc.type = spec.type ?? 'sine'
  osc.frequency.setValueAtTime(spec.freq, start)

  if (spec.freqTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(spec.freqTo, start + spec.attack + hold * 0.6)
  }

  osc.detune.setValueAtTime(spec.detune ?? 0, start)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + spec.attack)
  env.gain.setValueAtTime(Math.max(spec.gain, 0.0002), start + spec.attack + hold)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(env)
  env.connect(master)
  osc.start(start)
  osc.stop(end + 0.02)
}

/** 一段定长的白噪声，下面两个「气声」动作的原料。 */
function noiseSource(ac: AudioContext, seconds: number): AudioBufferSourceNode {
  const length = Math.floor(ac.sampleRate * seconds)
  const buffer = ac.createBuffer(1, length, ac.sampleRate)
  const data = buffer.getChannelData(0)

  for (let i = 0; i < length; i += 1) {
    data[i] = Math.random() * 2 - 1
  }

  const source = ac.createBufferSource()
  source.buffer = buffer

  return source
}

/** 一缕带通白噪声：PS5 菜单那种「空气感」。 */
function airPuff(ac: AudioContext, master: GainNode, t0: number, spec: AirPuffSpec): void {
  const source = noiseSource(ac, 0.12)
  const filter = ac.createBiquadFilter()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const end = start + spec.decay

  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(spec.freq, start)
  filter.Q.setValueAtTime(spec.q ?? 1.2, start)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + 0.018)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  source.connect(filter)
  filter.connect(env)
  env.connect(master)
  source.start(start)
  source.stop(end + 0.02)
}

/** 带通噪声扫频：柔和的「送出 / 呼啸」动作。 */
function whooshVoice(ac: AudioContext, master: GainNode, t0: number, spec: WhooshSpec): void {
  const source = noiseSource(ac, 0.4)
  const filter = ac.createBiquadFilter()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const end = start + spec.decay

  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(spec.freqFrom, start)
  filter.frequency.exponentialRampToValueAtTime(spec.freqTo, end)
  filter.Q.setValueAtTime(spec.q ?? 0.8, start)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + 0.03)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  source.connect(filter)
  filter.connect(env)
  env.connect(master)
  source.start(start)
  source.stop(end + 0.02)
}

/** 扫频啁啾：调制解调器 / 科幻感。 */
function sweepVoice(ac: AudioContext, master: GainNode, t0: number, spec: SweepSpec): void {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = t0 + (spec.start ?? 0)
  const attack = spec.attack ?? 0.003
  const end = start + spec.decay

  osc.type = spec.type ?? 'triangle'
  osc.frequency.setValueAtTime(spec.freqFrom, start)
  osc.frequency.exponentialRampToValueAtTime(spec.freqTo, end - 0.02)

  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(Math.max(spec.gain, 0.0002), start + attack)
  env.gain.exponentialRampToValueAtTime(0.0001, end)

  osc.connect(env)
  env.connect(master)
  osc.start(start)
  osc.stop(end + 0.02)
}

let reverbImpulse: AudioBuffer | null = null

/** 一点湿声让铃声像在屋里响，而不是铁皮罐头里。脉冲只生成一次，混响节点每次新造。 */
function makeReverb(ac: AudioContext): ConvolverNode {
  if (reverbImpulse === null) {
    const seconds = 1.6
    const length = Math.floor(ac.sampleRate * seconds)
    reverbImpulse = ac.createBuffer(2, length, ac.sampleRate)

    for (let channel = 0; channel < 2; channel += 1) {
      const data = reverbImpulse.getChannelData(channel)

      for (let i = 0; i < length; i += 1) {
        // 指数衰减的白噪声 → 平滑短尾巴
        data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.6
      }
    }
  }

  const convolver = ac.createConvolver()
  convolver.buffer = reverbImpulse

  return convolver
}

export interface CompletionSoundVariant {
  id: number
  /** 设置下拉里显示的名字。 */
  name: string
  play: (ac: AudioContext, master: GainNode, t0: number) => void
}

// 音名（十二平均律）。全部落在中低音区（C3–C5），听感偏暖、像「应用提示」
// 而不是街机音效。
const A2 = 110
const A3 = 220
const A4 = 440
const A5 = 880
const B5 = 987.77
const C3 = 130.81
const C4 = 261.63
const E4 = 329.63
const E5 = 659.25
const E6 = 1318.51
const G4 = 392
const G5 = 783.99
const C5 = 523.25
const C6 = 1046.5

export const COMPLETION_SOUND_VARIANTS: readonly CompletionSoundVariant[] = [
  {
    id: 1,
    name: '双音轻抚',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: E4, dur: 0.22, gain: 0.05, attack: 0.03, type: 'sine' })
      voice(ac, master, t0 + 0.08, { freq: C4, dur: 0.52, gain: 0.07, attack: 0.08, type: 'sine' })
      voice(ac, master, t0 + 0.08, { freq: C3, dur: 0.46, gain: 0.02, attack: 0.1, type: 'sine' })
    },
  },
  {
    id: 2,
    name: '玻璃清鸣',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: C6, dur: 0.55, gain: 0.032, attack: 0.002, type: 'sine' })
      voice(ac, master, t0 + 0.01, { freq: E5, dur: 0.42, gain: 0.018, attack: 0.004, type: 'sine' })
      airPuff(ac, master, t0, { freq: 3200, gain: 0.004, decay: 0.1, q: 1.4 })
    },
  },
  {
    id: 3,
    name: '柔木琴',
    play: (ac, master, t0) => {
      pluckVoice(ac, master, t0, { freqFrom: E5, freqTo: G5, gain: 0.03, decay: 0.14, glide: 0.08 })
      bloomVoice(ac, master, t0 + 0.04, { freq: C5, gain: 0.028, attack: 0.08, hold: 0.04, decay: 0.62 })
      bloomVoice(ac, master, t0 + 0.06, { freq: G4, gain: 0.014, attack: 0.12, hold: 0.06, decay: 0.55 })
    },
  },
  {
    id: 4,
    name: '三音讯号',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: C6, dur: 0.14, gain: 0.045, attack: 0.004, type: 'sine' })
      voice(ac, master, t0 + 0.1, { freq: A5, dur: 0.16, gain: 0.04, attack: 0.004, type: 'sine' })
      voice(ac, master, t0 + 0.2, { freq: G5, dur: 0.22, gain: 0.035, attack: 0.006, type: 'sine' })
    },
  },
  {
    id: 5,
    name: '风声掠过',
    play: (ac, master, t0) => {
      whooshVoice(ac, master, t0, { freqFrom: 4200, freqTo: 900, gain: 0.022, decay: 0.28, q: 0.7 })
      voice(ac, master, t0 + 0.12, { freq: A5, dur: 0.35, gain: 0.02, attack: 0.02, type: 'sine' })
    },
  },
  {
    id: 6,
    name: '发现之簇',
    play: (ac, master, t0) => {
      const clusterDetunes = [-14, -5, 0, 7, 12]

      clusterDetunes.forEach((detune, i) => {
        bloomVoice(ac, master, t0 + i * 0.03, {
          freq: A3,
          gain: 0.012,
          attack: 0.38,
          hold: 0.12,
          decay: 1.05,
          detune,
        })
      })
      bloomVoice(ac, master, t0 + 0.1, { freq: E4, gain: 0.008, attack: 0.45, hold: 0.08, decay: 0.9, detune: 3 })
    },
  },
  {
    id: 7,
    name: '系统上线',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: C5, dur: 0.16, gain: 0.04, attack: 0.006, type: 'sine' })
      voice(ac, master, t0 + 0.09, { freq: G5, dur: 0.28, gain: 0.042, attack: 0.008, type: 'sine' })
      voice(ac, master, t0 + 0.09, { freq: C4, dur: 0.24, gain: 0.012, attack: 0.01, type: 'sine' })
    },
  },
  {
    id: 8,
    name: '老式终端',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: B5, dur: 0.12, gain: 0.038, attack: 0.002, type: 'square' })
      voice(ac, master, t0 + 0.14, { freq: E5, dur: 0.1, gain: 0.028, attack: 0.002, type: 'square' })
    },
  },
  {
    id: 9,
    name: '调制解调',
    play: (ac, master, t0) => {
      sweepVoice(ac, master, t0, { freqFrom: 320, freqTo: 2200, gain: 0.024, decay: 0.16, type: 'triangle' })
      sweepVoice(ac, master, t0 + 0.1, { freqFrom: 480, freqTo: 1400, gain: 0.014, decay: 0.12, type: 'sine' })
    },
  },
  {
    id: 10,
    name: '风铃',
    play: (ac, master, t0) => {
      const chimes = [G5, C6, E5, A5]

      chimes.forEach((frequency, i) => {
        voice(ac, master, t0 + i * 0.13, {
          freq: frequency,
          dur: 0.72,
          gain: 0.028 - i * 0.003,
          attack: 0.003,
          type: 'sine',
        })
      })
    },
  },
  {
    id: 11,
    name: '颂钵',
    play: (ac, master, t0) => {
      bloomVoice(ac, master, t0, { freq: A3, gain: 0.022, attack: 0.58, hold: 0.16, decay: 1.35 })
      bloomVoice(ac, master, t0 + 0.08, { freq: E4, gain: 0.01, attack: 0.62, hold: 0.12, decay: 1.2, detune: 4 })
      bloomVoice(ac, master, t0 + 0.14, { freq: A4, gain: 0.006, attack: 0.68, hold: 0.08, decay: 1.05, detune: -3 })
    },
  },
  {
    id: 12,
    name: '竖琴拾音',
    play: (ac, master, t0) => {
      const notes = [C5, E5, G5, C6]

      notes.forEach((frequency, i) => {
        voice(ac, master, t0 + i * 0.075, {
          freq: frequency,
          dur: 0.38,
          gain: 0.034 - i * 0.004,
          attack: 0.012,
          type: 'sine',
        })
      })

      bloomVoice(ac, master, t0 + 0.2, { freq: C4, gain: 0.01, attack: 0.18, hold: 0.06, decay: 0.7 })
    },
  },
  {
    id: 13,
    name: '声呐',
    play: (ac, master, t0) => {
      voice(ac, master, t0, { freq: A2, dur: 0.95, gain: 0.036, attack: 0.008, type: 'sine' })
      voice(ac, master, t0 + 0.42, { freq: A3, dur: 0.55, gain: 0.014, attack: 0.01, type: 'sine' })
      airPuff(ac, master, t0, { freq: 600, gain: 0.005, decay: 0.2, q: 0.5 })
    },
  },
  {
    id: 14,
    name: '八音盒',
    play: (ac, master, t0) => {
      const notes = [E6, C6, G5, E5]

      notes.forEach((frequency, i) => {
        pluckVoice(ac, master, t0 + i * 0.09, {
          freqFrom: frequency,
          freqTo: frequency * 0.998,
          gain: 0.02 - i * 0.002,
          decay: 0.2,
          glide: 0.06,
        })
      })
    },
  },
] as const

// 整个窗口共享一个 AudioContext：浏览器限制一个页面能开多少个 context，
// 而这些提示音都是短促的振荡器爆音，彼此也不需要隔离。创建了就不关，陪窗口到老。
let sharedContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null

  try {
    if (sharedContext === null) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (Ctor === undefined) return null
      sharedContext = new Ctor()
    }

    // 自动播放策略可能把 context 挂起（窗口还没被点过）；resume 一下，用户交互过就能救回来。
    if (sharedContext.state === 'suspended') {
      void sharedContext.resume().catch(() => undefined)
    }

    return sharedContext
  } catch {
    return null
  }
}

function playVariant(variantId: number): void {
  const variant = COMPLETION_SOUND_VARIANTS.find((item) => item.id === variantId)
  if (variant === undefined) return

  const ac = getAudioContext()
  if (ac === null) return

  // 信号链：voices → master → 低通 → (干声 + 混响湿声) → 输出。
  const master = ac.createGain()
  const tone = ac.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.setValueAtTime(3800, ac.currentTime)
  tone.Q.setValueAtTime(0.32, ac.currentTime)
  master.gain.setValueAtTime(0.48, ac.currentTime)
  master.connect(tone)

  const dry = ac.createGain()
  dry.gain.setValueAtTime(0.88, ac.currentTime)
  tone.connect(dry)
  dry.connect(ac.destination)

  const reverb = makeReverb(ac)
  const wet = ac.createGain()
  wet.gain.setValueAtTime(0.34, ac.currentTime)
  tone.connect(reverb)
  reverb.connect(wet)
  wet.connect(ac.destination)

  variant.play(ac, master, ac.currentTime + 0.01)
}

/**
 * 播一声音色。两个调用方：回合完成时的提示（App 传设置里的编号）与设置里
 * 「选中即试听」——试听不受「完成提示音」开关管（hermes 同款：静音时也要能挑音色），
 * 所以开关判断放在调用方，这里只管发声。
 */
export function playCompletionSound(variantId: number): void {
  playVariant(variantId)
}

interface AirPuffSpec {
  decay: number
  freq: number
  gain: number
  q?: number
  start?: number
}

interface BloomSpec {
  attack: number
  decay: number
  detune?: number
  freq: number
  freqTo?: number
  gain: number
  hold?: number
  start?: number
  type?: OscillatorType
}

interface PluckSpec {
  attack?: number
  decay: number
  freqFrom: number
  freqTo: number
  gain: number
  glide?: number
  start?: number
}

interface SweepSpec {
  attack?: number
  decay: number
  freqFrom: number
  freqTo: number
  gain: number
  start?: number
  type?: OscillatorType
}

interface ToneSpec {
  attack?: number
  dur: number
  freq: number
  gain?: number
  start?: number
  type?: OscillatorType
}

interface WhooshSpec {
  decay: number
  freqFrom: number
  freqTo: number
  gain: number
  q?: number
  start?: number
}
