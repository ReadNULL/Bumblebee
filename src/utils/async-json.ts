import { Worker } from 'worker_threads'

export interface AsyncJsonStringifyOptions {
  space?: number
  workerThreshold?: number
}

const DEFAULT_WORKER_THRESHOLD = 128 * 1024

export async function stringifyJsonAsync(
  value: unknown,
  options: AsyncJsonStringifyOptions = {}
): Promise<string> {
  const space = options.space ?? 0
  const threshold = options.workerThreshold ?? DEFAULT_WORKER_THRESHOLD

  if (estimatePayloadSize(value, threshold) < threshold) {
    return JSON.stringify(value, null, space)
  }

  return stringifyInWorker(value, space)
}

function estimatePayloadSize(value: unknown, stopAt: number): number {
  const seen = new Set<object>()
  const stack: unknown[] = [value]
  let size = 0

  while (stack.length > 0 && size < stopAt) {
    const current = stack.pop()
    if (current === null || current === undefined) {
      size += 4
      continue
    }

    switch (typeof current) {
      case 'string':
        size += current.length
        break
      case 'number':
      case 'boolean':
      case 'bigint':
        size += String(current).length
        break
      case 'object':
        if (seen.has(current)) break
        seen.add(current)
        if (Array.isArray(current)) {
          stack.push(...current)
        } else {
          for (const [key, nested] of Object.entries(current)) {
            size += key.length
            stack.push(nested)
          }
        }
        break
      default:
        break
    }
  }

  return size
}

function stringifyInWorker(value: unknown, space: number): Promise<string> {
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads')
    try {
      parentPort.postMessage({ ok: true, json: JSON.stringify(workerData.value, null, workerData.space) })
    } catch (error) {
      parentPort.postMessage({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  `

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { value, space },
    })

    worker.once('message', (message: { ok: boolean; json?: string; message?: string }) => {
      void worker.terminate()
      if (message.ok) {
        resolve(message.json ?? '')
      } else {
        reject(new Error(message.message || 'JSON stringify worker failed'))
      }
    })
    worker.once('error', reject)
    worker.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`JSON stringify worker exited with code ${code}`))
      }
    })
  })
}
