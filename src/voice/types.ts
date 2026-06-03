/**
 * 语音交互类型定义
 *
 * 支持语音输入输出功能
 */

// 语音引擎类型
export type VoiceEngine = 'browser' | 'whisper' | 'azure' | 'google'

// 语音状态
export type VoiceStatus = 'idle' | 'listening' | 'processing' | 'speaking' | 'error'

// 语音配置
export interface VoiceConfig {
  engine: VoiceEngine
  language: string
  autoDetect?: boolean
  continuous?: boolean
  interimResults?: boolean
  maxDuration?: number        // 最大录音时长（毫秒）
  silenceTimeout?: number     // 静音超时（毫刻）
}

// 语音识别结果
export interface SpeechRecognitionResult {
  text: string
  confidence: number
  isFinal: boolean
  language?: string
  timestamp: Date
}

// 语音合成选项
export interface SpeechSynthesisOptions {
  text: string
  voice?: string
  rate?: number               // 语速 0.1-10
  pitch?: number              // 音调 0-2
  volume?: number             // 音量 0-1
  language?: string
}

// 语音事件
export type VoiceEvent =
  | { type: 'start'; timestamp: Date }
  | { type: 'result'; result: SpeechRecognitionResult }
  | { type: 'end'; timestamp: Date }
  | { type: 'error'; error: string }
  | { type: 'state-change'; state: VoiceStatus }

// 语音事件处理器
export type VoiceEventHandler = (event: VoiceEvent) => void

// 语音适配器接口
export interface VoiceAdapter {
  // 基本信息
  name: string
  engine: VoiceEngine

  // 状态
  status: VoiceStatus

  // 生命周期
  initialize(): Promise<void>
  destroy(): Promise<void>

  // 语音识别
  startListening(): Promise<void>
  stopListening(): Promise<void>

  // 语音合成
  speak(options: SpeechSynthesisOptions): Promise<void>
  stopSpeaking(): Promise<void>

  // 事件处理
  onEvent(handler: VoiceEventHandler): void

  // 配置
  configure(config: Partial<VoiceConfig>): void
}
