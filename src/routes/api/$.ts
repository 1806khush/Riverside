import { createFileRoute } from '@tanstack/react-router'
import { forwardMediaRequest } from '../../media.server'

export const Route = createFileRoute('/api/$')({
  server: {
    handlers: {
      GET: ({ request }) => forwardMediaRequest(request),
      POST: ({ request }) => forwardMediaRequest(request),
    },
  },
})
