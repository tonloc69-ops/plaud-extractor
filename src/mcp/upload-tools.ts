import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { loadCredentials, isExpired } from '../auth/token-store.js'
import { PlaudApiClient } from '../client/plaud-client.js'
import { getLogger } from '../logger.js'
import { stateDir } from '../storage/paths.js'

// ─── Manifest ─────────────────────────────────────────────────────────────────

interface ManifestEntry {
  sourceFile: string
  sourceHash: string
  plaudRecordingId: string
  title: string
  uploadedAt: string
  transcriptionStatus: 'uploaded' | 'transcribing' | 'complete' | 'error'
  error?: string
}

interface Manifest {
  entries: ManifestEntry[]
}

function manifestPath(outDir: string): string {
  return path.join(stateDir(outDir), 'upload_manifest.json')
}

async function loadManifest(outDir: string): Promise<Manifest> {
  try {
    const raw = await fsp.readFile(manifestPath(outDir), 'utf8')
    return JSON.parse(raw) as Manifest
  } catch {
    return { entries: [] }
  }
}

async function saveManifest(outDir: string, manifest: Manifest): Promise<void> {
  await fsp.mkdir(path.dirname(manifestPath(outDir)), { recursive: true })
  await fsp.writeFile(manifestPath(outDir), JSON.stringify(manifest, null, 2))
}

function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16)
}

function detectFileType(filePath: string): 'MP3' | 'AAC' | 'OPUS' {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.opus') return 'OPUS'
  if (ext === '.mp3') return 'MP3'
  // m4a, aac, and everything else -> MP3 (Plaud API treats these equivalently)
  return 'MP3'
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerUploadTools(server: McpServer, outDir: string): void {

  // ── plaud_upload ──────────────────────────────────────────────────────────

  server.tool(
    'plaud_upload',
    'Upload a single audio file to Plaud cloud for transcription, speaker diarization, and AI summary. Returns the recording ID and optionally waits for transcription to complete.',
    {
      file_path: z.string().describe('Absolute path to the audio file (.m4a, .mp3, .wav, .opus)'),
      title: z.string().describe('Display name for the recording in Plaud (e.g. "Coaching Session - 2021-05-21")'),
      start_time: z.string().describe('ISO date of when the recording was made (e.g. "2024-05-23T15:01:00")'),
      wait_for_transcript: z.boolean().default(true).describe('Wait for transcription to complete before returning (default true)'),
      language: z.string().default('en').describe('Transcription language code (default "en")'),
    },
    async ({ file_path, title, start_time, wait_for_transcript, language }) => {
      const log = getLogger()

      // Validate file exists
      if (!fs.existsSync(file_path)) {
        return { content: [{ type: 'text' as const, text: `Error: file not found: ${file_path}` }] }
      }

      // Check auth
      const creds = await loadCredentials().catch(() => null)
      if (!creds) {
        return { content: [{ type: 'text' as const, text: 'Error: not authenticated. Run: alta-plaud auth' }] }
      }
      if (isExpired(creds)) {
        return { content: [{ type: 'text' as const, text: 'Error: token expired. Run: alta-plaud auth' }] }
      }

      // Check manifest for duplicates
      const manifest = await loadManifest(outDir)
      const fileHash = hashFile(file_path)
      const existing = manifest.entries.find(e => e.sourceHash === fileHash)
      if (existing) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'skipped',
              reason: 'already_uploaded',
              plaudRecordingId: existing.plaudRecordingId,
              title: existing.title,
              uploadedAt: existing.uploadedAt,
            }, null, 2),
          }],
        }
      }

      const client = new PlaudApiClient(creds)
      const fileType = detectFileType(file_path)
      const startDate = new Date(start_time)

      try {
        // Upload
        log.info({ file_path, title, fileType }, 'Starting upload')
        const recording = await client.upload(file_path, { title, startTime: startDate, fileType })
        const recordingId = String(recording.id ?? '')

        if (!recordingId) {
          return { content: [{ type: 'text' as const, text: 'Error: upload succeeded but no recording ID returned' }] }
        }

        // Track in manifest
        const entry: ManifestEntry = {
          sourceFile: file_path,
          sourceHash: fileHash,
          plaudRecordingId: recordingId,
          title,
          uploadedAt: new Date().toISOString(),
          transcriptionStatus: 'uploaded',
        }

        let transcriptPreview = ''

        if (wait_for_transcript) {
          try {
            entry.transcriptionStatus = 'transcribing'
            await client.triggerTranscription(recordingId, language)
            const result = await client.pollTranscription(recordingId, { language })

            entry.transcriptionStatus = 'complete'
            const segments = result.data_result as Array<{ text?: string }> | undefined
            if (segments?.length) {
              transcriptPreview = segments.map(s => s.text ?? '').filter(Boolean).join(' ').slice(0, 200)
            }
          } catch (err) {
            entry.transcriptionStatus = 'error'
            entry.error = String(err)
            log.error({ err, recordingId }, 'Transcription failed')
          }
        }

        manifest.entries.push(entry)
        await saveManifest(outDir, manifest)

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              recording_id: recordingId,
              status: entry.transcriptionStatus,
              title,
              start_time,
              file_type: fileType,
              transcript_preview: transcriptPreview || undefined,
              error: entry.error || undefined,
            }, null, 2),
          }],
        }
      } catch (err) {
        log.error({ err, file_path }, 'Upload failed')
        return {
          content: [{
            type: 'text' as const,
            text: `Error uploading ${file_path}: ${String(err)}`,
          }],
        }
      }
    },
  )

  // ── plaud_upload_batch ────────────────────────────────────────────────────

  server.tool(
    'plaud_upload_batch',
    'Upload multiple audio files from a folder to Plaud with throttling. Tracks progress via manifest for idempotent re-runs. Returns a jobId for background processing.',
    {
      folder_path: z.string().describe('Absolute path to folder containing audio files'),
      file_pattern: z.string().default('*.m4a').describe('Glob pattern for audio files (default "*.m4a")'),
      throttle_seconds: z.number().default(180).describe('Seconds between uploads (default 180 = 3 min)'),
      limit: z.number().int().min(1).default(10).describe('Max files per run (default 10)'),
      dry_run: z.boolean().default(false).describe('Preview what would be uploaded without uploading'),
      language: z.string().default('en').describe('Transcription language code (default "en")'),
    },
    async ({ folder_path, file_pattern, throttle_seconds, limit, dry_run, language }) => {
      const log = getLogger()

      // Validate folder
      if (!fs.existsSync(folder_path)) {
        return { content: [{ type: 'text' as const, text: `Error: folder not found: ${folder_path}` }] }
      }

      // Check auth
      const creds = await loadCredentials().catch(() => null)
      if (!creds) {
        return { content: [{ type: 'text' as const, text: 'Error: not authenticated. Run: alta-plaud auth' }] }
      }
      if (isExpired(creds)) {
        return { content: [{ type: 'text' as const, text: 'Error: token expired. Run: alta-plaud auth' }] }
      }

      // Discover audio files
      const entries = await fsp.readdir(folder_path)
      const extMatch = file_pattern.replace('*', '')
      const audioFiles = entries
        .filter(f => f.toLowerCase().endsWith(extMatch.toLowerCase()))
        .map(f => path.join(folder_path, f))
        .sort()

      if (audioFiles.length === 0) {
        return { content: [{ type: 'text' as const, text: `No files matching ${file_pattern} in ${folder_path}` }] }
      }

      // Load manifest and filter already-uploaded
      const manifest = await loadManifest(outDir)
      const uploadedHashes = new Set(manifest.entries.map(e => e.sourceHash))

      const toUpload: Array<{ path: string; hash: string; title: string; startTime: Date }> = []
      const skipped: string[] = []

      for (const filePath of audioFiles) {
        if (toUpload.length >= limit) break

        const hash = hashFile(filePath)
        if (uploadedHashes.has(hash)) {
          skipped.push(path.basename(filePath))
          continue
        }

        // Derive title and date from filename
        // Pattern: "YYYYMMDD HHMMSS-HEXID.m4a" (Voice Memos)
        const basename = path.basename(filePath, path.extname(filePath))
        const dateMatch = basename.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2})(\d{2})(\d{2})/)
        let startTime: Date
        let title: string

        if (dateMatch) {
          const [, y, mo, d, h, mi, s] = dateMatch
          startTime = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`)
          title = `Voice Memo ${y}-${mo}-${d} ${h}:${mi}`
        } else {
          startTime = new Date(fs.statSync(filePath).birthtime)
          title = `Voice Memo - ${basename}`
        }

        toUpload.push({ path: filePath, hash, title, startTime })
      }

      if (dry_run) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              dry_run: true,
              total_files: audioFiles.length,
              would_upload: toUpload.length,
              would_skip: skipped.length,
              skipped_files: skipped,
              files: toUpload.map(f => ({
                path: f.path,
                title: f.title,
                start_time: f.startTime.toISOString(),
              })),
              estimated_time_minutes: Math.ceil((toUpload.length * throttle_seconds) / 60),
            }, null, 2),
          }],
        }
      }

      // Process uploads with throttling
      const client = new PlaudApiClient(creds)
      let uploaded = 0
      let errors = 0
      const results: Array<{ file: string; status: string; id?: string; error?: string }> = []

      for (let i = 0; i < toUpload.length; i++) {
        const file = toUpload[i]!

        try {
          log.info({ file: file.path, title: file.title, index: i + 1, total: toUpload.length }, 'Batch upload')
          const recording = await client.upload(file.path, {
            title: file.title,
            startTime: file.startTime,
            fileType: detectFileType(file.path),
          })

          const recordingId = String(recording.id ?? '')

          // Trigger transcription (don't wait in batch mode)
          if (recordingId) {
            try {
              await client.triggerTranscription(recordingId, language)
            } catch (err) {
              log.error({ err, recordingId }, 'Failed to trigger transcription')
            }
          }

          manifest.entries.push({
            sourceFile: file.path,
            sourceHash: file.hash,
            plaudRecordingId: recordingId,
            title: file.title,
            uploadedAt: new Date().toISOString(),
            transcriptionStatus: 'transcribing',
          })
          await saveManifest(outDir, manifest)

          uploaded++
          results.push({ file: path.basename(file.path), status: 'uploaded', id: recordingId })
        } catch (err) {
          errors++
          results.push({ file: path.basename(file.path), status: 'error', error: String(err) })
          log.error({ err, file: file.path }, 'Batch upload failed for file')
        }

        // Throttle between uploads (skip after last file)
        if (i < toUpload.length - 1) {
          log.info({ throttle_seconds }, 'Throttling between uploads')
          await new Promise(resolve => setTimeout(resolve, throttle_seconds * 1000))
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            uploaded,
            skipped: skipped.length,
            errors,
            total_files: audioFiles.length,
            manifest_path: manifestPath(outDir),
            results,
          }, null, 2),
        }],
      }
    },
  )
}
