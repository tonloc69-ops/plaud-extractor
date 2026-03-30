import { AuthError } from '../errors.js'
import { getLogger } from '../logger.js'
import { IncrementalTracker } from './incremental.js'
import { processQueue, retryWithBackoff } from './download-queue.js'
import { RecordingStore } from '../storage/recording-store.js'
import { DatasetWriter } from '../storage/dataset-writer.js'
import type { SyncOptions, SyncResult, BackfillOptions } from './types.js'
import type { PlaudClient, PlaudRecording } from '../client/types.js'
import type { HttpClient } from '../client/http.js'

export class SyncEngine {
  async run(
    client: PlaudClient,
    opts: SyncOptions,
    mode: 'sync' | 'backfill' = 'sync',
  ): Promise<SyncResult> {
    const log = getLogger()
    const startedAt = Date.now()

    // 1. Verify auth
    const authed = await client.isAuthenticated()
    if (!authed) {
      throw new AuthError("Not authenticated — run 'alta-plaud auth' first")
    }

    // 2. Load sync state
    const tracker = new IncrementalTracker()
    await tracker.load(opts.outDir)

    // 3. Determine effective --since
    const since = opts.since ?? (mode === 'sync' ? tracker.getSince() : undefined)

    log.info({ mode, since: since?.toISOString(), outDir: opts.outDir }, 'Starting sync')

    // 4. Collect recordings to process
    // For backfill mode, always enumerate ALL recordings (no limit on listing)
    // so that old recordings deep in pagination are included.
    // The limit only caps how many get re-downloaded, not how many are listed.
    const listLimit = mode === 'backfill' ? undefined : opts.limit
    const toProcess: PlaudRecording[] = []
    const skipped: PlaudRecording[] = []
    let listCount = 0

    for await (const recording of client.listRecordings({ since, limit: listLimit })) {
      listCount++
      if (mode === 'sync' && !tracker.needsDownload(recording)) {
        skipped.push(recording)
      } else {
        toProcess.push(recording)
      }

      if (opts.limit && toProcess.length >= opts.limit) break
    }

    log.info(
      { total: listCount, toProcess: toProcess.length, skipped: skipped.length },
      'Recordings collected',
    )

    // 5. Dry run — just print plan
    if (opts.dryRun) {
      for (const rec of toProcess) {
        log.info(
          { id: rec.id, title: rec.title, recordedAt: rec.recordedAt },
          '[dry-run] Would download',
        )
      }
      return {
        mode,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: skipped.length,
        durationMs: Date.now() - startedAt,
        errors: [],
      }
    }

    // 6. Initialize storage
    const store = new RecordingStore(opts.outDir)
    const dataset = opts.includeDataset ? new DatasetWriter(opts.outDir) : null
    if (dataset) await dataset.open()

    // 7. Run download queue
    const errors: Array<{ recordingId: string; error: Error }> = []
    const httpClient = getHttpClient(client)

    const { succeeded, failed } = await processQueue(
      toProcess,
      async (recording) => {
        await retryWithBackoff(
          () => downloadRecording(recording, client, store, dataset, tracker, httpClient, opts),
          { label: `recording:${recording.id}` },
        )
      },
      opts.concurrency,
    )

    for (const { item, error } of failed) {
      errors.push({ recordingId: item.id, error })
      log.error({ recordingId: item.id, err: error }, 'Failed to download recording')
    }

    // 8. Mark successful sync only if zero failures
    if (errors.length === 0) {
      tracker.markSuccessfulSync()
    }

    // 9. Persist state
    await tracker.persist(opts.outDir)

    if (dataset) await dataset.close()

    const result: SyncResult = {
      mode,
      attempted: toProcess.length,
      succeeded: succeeded.length,
      failed: failed.length,
      skipped: skipped.length,
      durationMs: Date.now() - startedAt,
      errors,
      datasetPath: dataset?.path,
    }

    log.info(result, 'Sync complete')
    return result
  }
}

async function downloadRecording(
  recording: PlaudRecording,
  client: PlaudClient,
  store: RecordingStore,
  dataset: DatasetWriter | null,
  tracker: IncrementalTracker,
  httpClient: HttpClient | null,
  opts: SyncOptions,
): Promise<void> {
  const log = getLogger()
  log.info({ recordingId: recording.id, title: recording.title }, 'Downloading recording')

  // a. Write metadata
  await store.writeMetadata(recording)

  // b. Download transcript
  let hasTranscript = false
  if (recording.hasTranscript) {
    try {
      const transcript = await client.getTranscript(recording.id)
      await store.writeTranscript(recording, transcript, opts.formats)
      if (dataset) {
        await dataset.append(opts.outDir, recording, transcript)
      }
      hasTranscript = true
    } catch (err) {
      log.warn({ recordingId: recording.id, err }, 'Failed to get transcript')
    }
  }

  // c. Download audio
  let hasAudio = false
  if (httpClient) {
    const audioUrl = await client.getAudioDownloadUrl(recording.id)
    if (audioUrl) {
      hasAudio = await store.writeAudioFromUrl(recording, audioUrl, httpClient)
    }
  }

  // d. Write checksums
  await store.writeChecksums(recording)

  // e. Mark complete in state
  tracker.markComplete(recording.id, recording.recordedAt, {
    hasAudio,
    hasTranscript,
    contentHash: tracker.computeContentHash(recording),
  })
}

/** Extract HttpClient from PlaudApiClient for audio downloads */
function getHttpClient(client: PlaudClient): HttpClient | null {
  // PlaudApiClient exposes getHttpClient()
  if ('getHttpClient' in client && typeof (client as { getHttpClient?: () => HttpClient }).getHttpClient === 'function') {
    return (client as { getHttpClient: () => HttpClient }).getHttpClient()
  }
  return null
}
