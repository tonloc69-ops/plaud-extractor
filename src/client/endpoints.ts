import type { EndpointMap } from '../auth/types.js'

export type { EndpointMap }

// ---------------------------------------------------------------------------
// Real Plaud API paths (discovered from arbuzmell/plaud-api reference client)
// The user's account lives on a regional endpoint (e.g. api-euc1.plaud.ai for EU).
// Hit api.plaud.ai/user/me to discover the correct regional base URL.
// ---------------------------------------------------------------------------

const API_BASE = (map: EndpointMap) => map.apiBaseUrl ?? 'https://api.plaud.ai'

/**
 * Build list URL using skip/limit pagination.
 * GET /file/simple/web?skip=N&limit=50&is_trash=0&sort_by=start_time&is_desc=true
 */
export function buildListUrl(map: EndpointMap, skip: number, limit = 50): string {
  const base = map.listRecordings ?? `${API_BASE(map)}/file/simple/web`
  const url = new URL(base.replace('/{id}', ''))
  url.searchParams.set('skip', String(skip))
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('is_trash', '0')
  url.searchParams.set('sort_by', 'start_time')
  url.searchParams.set('is_desc', 'true')
  return url.toString()
}

/**
 * Build URL for POST /file/list — batch detail fetch that includes trans_result.
 * Body: ["file_id_1", "file_id_2"]
 * Response: { data_file_list: [...full recording objects with trans_result...] }
 */
export function buildBatchDetailUrl(map: EndpointMap): string {
  return map.batchDetail ?? `${API_BASE(map)}/file/list`
}

/**
 * Build URL for GET /file/temp-url/<id> — returns a presigned S3 audio download URL.
 * Response: { temp_url: "https://s3.amazonaws.com/...?X-Amz-..." }
 */
export function buildAudioTempUrl(map: EndpointMap, id: string): string {
  const base = map.getAudioUrl ?? `${API_BASE(map)}/file/temp-url`
  return `${base.replace('/{id}', '')}/${id}`
}

export function buildProfileUrl(map: EndpointMap): string {
  return map.userProfile ?? `${API_BASE(map)}/user/me`
}

// ─── Upload endpoints ─────────────────────────────────────────────────────────

export function buildUploadPresignedUrl(map: EndpointMap): string {
  return `${API_BASE(map)}/file/get_upload_presigned_url`
}

export function buildMergeMultipartUrl(map: EndpointMap): string {
  return `${API_BASE(map)}/file/merge_multipart`
}

export function buildConfirmUploadUrl(map: EndpointMap): string {
  return `${API_BASE(map)}/file/confirm_upload`
}

export function buildFileDetailUrl(map: EndpointMap, fileId: string): string {
  return `${API_BASE(map)}/file/${fileId}`
}

export function buildTransSummUrl(map: EndpointMap, fileId: string): string {
  return `${API_BASE(map)}/ai/transsumm/${fileId}`
}

/**
 * Discover the correct regional API base URL by hitting the global endpoint.
 * The global api.plaud.ai returns a region-redirect response:
 *   { status: -302, data: { domains: { api: "https://api-euc1.plaud.ai" } } }
 */
export function extractRegionalBaseUrl(response: unknown): string | null {
  const r = response as Record<string, unknown>
  if (r?.status === -302) {
    const api = (r?.data as Record<string, unknown>)?.domains as Record<string, unknown>
    if (typeof api?.api === 'string') return api.api
  }
  return null
}
