import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import studioCss from '../recorder/styles.css?url'
import presentationsCss from '../recorder/presentations.css?url'
import studioMarkup from '../recorder/studio.html?raw'

export const Route = createFileRoute('/record')({
  component: StudioPage,
  head: () => ({
    meta: [{ title: 'Recording studio · Mosaic Web' }],
    links: [
      { rel: 'stylesheet', href: studioCss },
      { rel: 'stylesheet', href: presentationsCss },
      { rel: 'stylesheet', href: '/teleprompter.css' },
    ],
  }),
})

// The recorder owns this static DOM subtree while it has live media tracks.
const studio = { __html: studioMarkup }

function StudioPage() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading')

  useEffect(() => {
    let mounted = true
    void import('../recorder/boot.js').then(
      () => { if (mounted) setStatus('ready') },
      (error: unknown) => {
        console.error('Could not load the recorder', error)
        if (mounted) setStatus('failed')
      },
    )
    return () => { mounted = false }
  }, [])

  return (
    <>
      {status === 'failed' && <p role="alert">The recording studio couldn’t start. Reload the page to try again.</p>}
      <div className="recorder-shell" inert={status !== 'ready'} dangerouslySetInnerHTML={studio} />
    </>
  )
}
