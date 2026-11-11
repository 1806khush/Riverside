import '@tanstack/react-start/server-only'

const slidePage = /^\/api\/presentations\/[a-f0-9]{32}\/pages\/[1-9][0-9]{0,2}\.png$/
const removeDeck = /^\/api\/presentations\/[a-f0-9]{32}\/remove$/
const recordingLimit = 16 * 1024 ** 3
const pdfLimit = 100 * 1024 ** 2

function error(status: number, message: string) {
  return Response.json({ error: message }, { status })
}

export async function forwardMediaRequest(request: Request) {
  const { origin, pathname, search } = new URL(request.url)
  const post = request.method === 'POST'
  const upload = post && (pathname === '/api/export' || pathname === '/api/presentations')
  const allowed = post ? upload || removeDeck.test(pathname) : slidePage.test(pathname)
  if (!allowed) return error(404, 'Media endpoint not found.')

  const requestOrigin = request.headers.get('origin')
  if (post && requestOrigin && requestOrigin !== origin) {
    return error(403, 'Request must come from the recording studio.')
  }

  const port = process.env.CPE_MEDIA_PORT
  const token = process.env.CPE_MEDIA_TOKEN
  if (!port || !token) return error(503, 'The media service is unavailable.')

  const headers = new Headers({ Authorization: `Bearer ${token}` })
  if (upload) {
    const contentType = request.headers.get('content-type')
    if (contentType !== 'application/octet-stream') return error(415, 'Expected a media upload.')
    const length = request.headers.get('content-length')
    if (!length || !/^\d+$/.test(length)) return error(411, 'The upload size is required.')
    const limit = pathname === '/api/export' ? recordingLimit : pdfLimit
    if (!request.body || Number(length) <= 0 || Number(length) > limit) {
      return error(413, pathname === '/api/export'
        ? 'Recording upload exceeds the 16 GB limit or is empty.'
        : 'Choose a non-empty PDF smaller than 100 MB.')
    }
    headers.set('Content-Type', contentType)
    headers.set('Content-Length', length)
    const fileName = request.headers.get('x-file-name')
    if (fileName) headers.set('X-File-Name', fileName)
  }

  const options: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    signal: request.signal,
    ...(upload ? { body: request.body, duplex: 'half' } : {}),
  }
  try {
    const upstream = await fetch(`http://127.0.0.1:${port}${pathname}${search}`, options)
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  } catch (cause) {
    if (!request.signal.aborted) console.error('Media service request failed', cause)
    return error(502, 'The media service could not complete the request.')
  }
}
