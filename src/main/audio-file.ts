import { readFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'aiff', 'opus']

export async function loadAudioFile(filePath: string): Promise<{ filePath: string; data: Uint8Array } | null> {
  // Only audio files: the path can come from a show file or the dev bridge
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  if (!AUDIO_EXTENSIONS.includes(ext)) return null
  // Check if already WAV — skip conversion
  const isWav = filePath.toLowerCase().endsWith('.wav')

  if (!isWav) {
    // Convert to WAV via macOS afconvert — handles MP3, AAC, FLAC, AIFF, etc.
    const tmpPath = join(tmpdir(), `tl_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`)
    try {
      await execFileAsync('/usr/bin/afconvert', [
        '-f', 'WAVE',   // output format: WAV
        '-d', 'LEI16',  // 16-bit little-endian PCM (preserves original sample rate)
        filePath,
        tmpPath,
      ])
      const buf = readFileSync(tmpPath)
      return { filePath, data: new Uint8Array(buf) }
    } catch (e) {
      console.error('[main] afconvert error:', e)
      return null
    } finally {
      if (existsSync(tmpPath)) { try { unlinkSync(tmpPath) } catch {} }
    }
  }

  try {
    const buf = readFileSync(filePath)
    return { filePath, data: new Uint8Array(buf) }
  } catch (e) {
    console.error('[main] audio read error:', e)
    return null
  }
}
