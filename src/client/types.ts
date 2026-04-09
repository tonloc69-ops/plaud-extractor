import { z } from 'zod'

export const TranscriptSegmentSchema = z.object({
  index: z.number(),
  startMs: z.number(),
  endMs: z.number(),
  speaker: z.string().optional(),
  text: z.string(),
  confidence: z.number().min(0).max(1).optional(),
})

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>

export const PlaudRecordingSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  /** Duration in seconds */
  duration: z.number(),
  recordedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  fileSize: z.number().optional(),
  mimeType: z.string().default('audio/mp4'),
  hasTranscript: z.boolean(),
  transcriptStatus: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
  language: z.string().optional(),
  deviceId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  folderId: z.string().optional(),
  summary: z.string().optional(),
  /** Raw API payload preserved verbatim for forward-compatibility */
  _raw: z.record(z.unknown()),
})

export type PlaudRecording = z.infer<typeof PlaudRecordingSchema>

export const PlaudTranscriptSchema = z.object({
  recordingId: z.string(),
  language: z.string().optional(),
  /** Duration in seconds */
  duration: z.number(),
  segments: z.array(TranscriptSegmentSchema),
  /** Concatenated full text for convenience */
  fullText: z.string(),
  createdAt: z.string().datetime().optional(),
  _raw: z.record(z.unknown()),
})

export type PlaudTranscript = z.infer<typeof PlaudTranscriptSchema>

export interface ListOptions {
  since?: Date
  limit?: number
  cursor?: string
}

export interface PlaudClient {
  isAuthenticated(): Promise<boolean>
  listRecordings(options?: ListOptions): AsyncGenerator<PlaudRecording>
  getTranscript(recordingId: string): Promise<PlaudTranscript>
  getAudioDownloadUrl(recordingId: string): Promise<string | null>
  upload(filePath: string, opts: {
    title: string
    startTime: Date
    fileType?: 'MP3' | 'AAC' | 'OPUS'
  }): Promise<Record<string, unknown>>
  triggerTranscription(fileId: string, language?: string): Promise<void>
  pollTranscription(fileId: string, opts?: {
    language?: string
    timeoutMs?: number
    pollIntervalMs?: number
  }): Promise<Record<string, unknown>>
}
