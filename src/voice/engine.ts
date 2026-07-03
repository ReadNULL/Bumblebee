/**
 * 语音交互引擎
 *
 * 负责语音识别和合成
 */

import {
  VoiceConfig,
  VoiceEngine,
  VoiceStatus,
  VoiceEvent,
  VoiceEventHandler,
  VoiceAdapter,
  SpeechRecognitionResult,
  SpeechSynthesisOptions
} from './types.js'

export class VoiceEngineImpl implements VoiceAdapter {
  name: string
  engine: VoiceEngine
  status: VoiceStatus = 'idle'

  private config: VoiceConfig
  private eventHandlers: VoiceEventHandler[] = []
  private recognition: any = null
  private synthesis: any = null

  constructor(config: VoiceConfig) {
    this.name = 'voice-engine'
    this.engine = config.engine
    this.config = config
  }

  // ========== 生命周期 ==========

  async initialize(): Promise<void> {
    if (this.engine !== 'browser') {
      throw new Error(`语音引擎 ${this.engine} 尚未实现，当前仅支持 browser`)
    }
    // 检查浏览器支持
    if (typeof window === 'undefined') {
      throw new Error('语音功能仅在浏览器环境中可用')
    }

    // 初始化语音识别
    const SpeechRecognition = (window as any).SpeechRecognition ||
                              (window as any).webkitSpeechRecognition

    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition()
      this.recognition.continuous = this.config.continuous ?? false
      this.recognition.interimResults = this.config.interimResults ?? true
      this.recognition.lang = this.config.language

      this.recognition.onstart = () => {
        this.setStatus('listening')
        this.emitEvent({ type: 'start', timestamp: new Date() })
      }

      this.recognition.onresult = (event: any) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          const recognitionResult: SpeechRecognitionResult = {
            text: result[0].transcript,
            confidence: result[0].confidence,
            isFinal: result.isFinal,
            timestamp: new Date()
          }
          this.emitEvent({ type: 'result', result: recognitionResult })
        }
      }

      this.recognition.onend = () => {
        this.setStatus('idle')
        this.emitEvent({ type: 'end', timestamp: new Date() })
      }

      this.recognition.onerror = (event: any) => {
        this.setStatus('error')
        this.emitEvent({ type: 'error', error: event.error })
      }
    }

    // 初始化语音合成
    if (window.speechSynthesis) {
      this.synthesis = window.speechSynthesis
    }
  }

  async destroy(): Promise<void> {
    await this.stopListening()
    await this.stopSpeaking()
    this.recognition = null
    this.synthesis = null
  }

  // ========== 语音识别 ==========

  async startListening(): Promise<void> {
    if (!this.recognition) {
      throw new Error('语音识别未初始化')
    }

    if (this.status === 'listening') {
      return
    }

    try {
      this.recognition.start()
    } catch (error) {
      this.setStatus('error')
      throw error
    }
  }

  async stopListening(): Promise<void> {
    if (this.recognition && this.status === 'listening') {
      this.recognition.stop()
    }
  }

  // ========== 语音合成 ==========

  async speak(options: SpeechSynthesisOptions): Promise<void> {
    if (!this.synthesis) {
      throw new Error('语音合成未初始化')
    }

    // 停止当前播放
    this.synthesis.cancel()

    const utterance = new SpeechSynthesisUtterance(options.text)

    // 设置语音参数
    if (options.voice) {
      const voices = this.synthesis.getVoices()
      const selectedVoice = voices.find((v: any) => v.name === options.voice)
      if (selectedVoice) {
        utterance.voice = selectedVoice
      }
    }

    utterance.rate = options.rate ?? 1
    utterance.pitch = options.pitch ?? 1
    utterance.volume = options.volume ?? 1
    utterance.lang = options.language ?? this.config.language

    return new Promise((resolve, reject) => {
      utterance.onend = () => {
        this.setStatus('idle')
        resolve()
      }

      utterance.onerror = (event: any) => {
        this.setStatus('error')
        reject(new Error(`语音合成错误: ${event.error}`))
      }

      this.setStatus('speaking')
      this.synthesis.speak(utterance)
    })
  }

  async stopSpeaking(): Promise<void> {
    if (this.synthesis) {
      this.synthesis.cancel()
      this.setStatus('idle')
    }
  }

  // ========== 事件处理 ==========

  onEvent(handler: VoiceEventHandler): void {
    this.eventHandlers.push(handler)
  }

  private emitEvent(event: VoiceEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event)
      } catch (error) {
        console.error('语音事件处理器错误:', error)
      }
    }
  }

  // ========== 配置 ==========

  configure(config: Partial<VoiceConfig>): void {
    this.config = { ...this.config, ...config }

    if (this.recognition) {
      this.recognition.continuous = this.config.continuous ?? false
      this.recognition.interimResults = this.config.interimResults ?? true
      this.recognition.lang = this.config.language
    }
  }

  // ========== 辅助方法 ==========

  private setStatus(status: VoiceStatus): void {
    this.status = status
    this.emitEvent({ type: 'state-change', state: status })
  }

  // 获取可用语音列表
  getVoices(): any[] {
    if (!this.synthesis) {
      return []
    }
    return this.synthesis.getVoices()
  }

  // 检查浏览器支持
  static isSupported(): boolean {
    if (typeof window === 'undefined') {
      return false
    }

    const hasRecognition = !!(window as any).SpeechRecognition ||
                          !!(window as any).webkitSpeechRecognition
    const hasSynthesis = !!window.speechSynthesis

    return hasRecognition && hasSynthesis
  }
}
