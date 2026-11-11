import {
  CaretDown, CheckCircle, DotsThree, FilmStrip, GearSix, List, MagnifyingGlass,
  Play, Plus, SquaresFour, Stack, VideoCamera, WarningCircle, X,
} from '@phosphor-icons/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { DB, type Recording } from '../recorder/storage'
import { recoverRecordings } from '../recorder/recording-recovery'
import { AppearanceSettings } from './AppearanceSettings'
import { Dialog } from './Dialog'
import { RecordingSort, type Order } from './RecordingSort'

const filters = [
  { id: 'all', label: 'All recordings', icon: Stack },
  { id: 'ready', label: 'Ready', icon: CheckCircle },
  { id: 'review', label: 'Needs review', icon: WarningCircle },
] as const
type Filter = typeof filters[number]['id']
type Modal = { kind: 'settings' | 'about' } | { kind: 'manage' | 'delete'; recording: Recording }

const needsReview = (recording: Recording) => !!recording.issues?.length
const reviewUrl = (id: string) => `/record?session=${encodeURIComponent(id)}`

function duration(ms: number) {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function NewRecording() {
  return <a className="mw-button mw-button-primary" href="/record"><Plus size={18} weight="bold" />New recording</a>
}

export function Dashboard() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [libraryOpen, setLibraryOpen] = useState(true)
  const [search, setSearch] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const [order, setOrder] = useState<Order>('recent')
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [modal, setModal] = useState<Modal | null>(null)

  useEffect(() => {
    let active = true
    let loadVersion = 0
    function refresh() {
      const version = ++loadVersion
      const showSessions = (sessions: Recording[]) => {
        if (!active || version !== loadVersion) return
        setRecordings(sessions.filter(({ status, stressTest }) => status === 'complete' && (import.meta.env.DEV || !stressTest)))
        setLoadError(false)
        setLoading(false)
      }
      void DB.listSessions().then(
        (sessions) => {
          showSessions(sessions)
          if (sessions.some(({ status }) => status === 'recording')) {
            void recoverRecordings().then(showSessions).catch(() => {})
          }
        },
        () => {
          if (!active || version !== loadVersion) return
          setLoadError(true)
          setLoading(false)
        },
      )
    }
    refresh()
    window.addEventListener('pageshow', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      window.removeEventListener('pageshow', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  const reviewCount = recordings.filter(needsReview).length
  const counts = { all: recordings.length, ready: recordings.length - reviewCount, review: reviewCount }
  const query = search.trim().toLocaleLowerCase()
  const results = recordings
    .filter((item) => (filter === 'all' || needsReview(item) === (filter === 'review')) && item.title.toLocaleLowerCase().includes(query))
    .sort((a, b) => order === 'name' ? a.title.localeCompare(b.title) : order === 'recent'
      ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt))
  const year = new Date().getFullYear()

  return (
    <>
      <div className="mw-splash" aria-hidden="true">
        <img className="mw-splash-mark" src="/only-logo.svg" alt="" width="500" height="500" />
        <img className="mw-splash-logo" src="/mosaic-web-logo.svg" alt="" width="450" height="151" />
        <span className="mw-splash-status">› <span>Starting Mosaic Web</span></span>
        <span className="mw-splash-progress" />
      </div>
      <div className="mw-workspace">
        <div className="mw-frame">
          <div className="mw-sidebar-slot">
            <aside className="mw-sidebar" aria-label="Workspace">
              <a href="/" className="mw-sidebar-brand" aria-label="Mosaic Web home">
                <img src="/mosaic-web-logo.svg" alt="Mosaic Web" width="450" height="151" />
              </a>
              <button className="mw-nav-row mw-library-toggle" type="button" aria-expanded={libraryOpen} aria-controls="recording-filters" onClick={() => setLibraryOpen(!libraryOpen)}>
                <Stack size={19} weight="duotone" />Library<CaretDown size={13} />
              </button>
              <nav className="mw-filters" id="recording-filters" hidden={!libraryOpen} aria-label="Filter recordings">
                {filters.map(({ id, label, icon: Icon }) => (
                  <button className="mw-nav-row" type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>
                    <Icon size={17} weight={filter === id ? 'fill' : 'regular'} />
                    <span>{label}</span>
                    {!loading && <small>{counts[id]}</small>}
                  </button>
                ))}
              </nav>
              <button className="mw-nav-row mw-settings-button" type="button" aria-haspopup="dialog" onClick={() => setModal({ kind: 'settings' })}>
                <GearSix size={18} />Settings
              </button>
            </aside>
          </div>
          <div className="mw-column">
            <main id="recordings" className="mw-content">
              <div className="mw-heading">
                <div>
                  <h1>{filters.find(({ id }) => id === filter)?.label}</h1>
                  <p>{loading ? 'Loading recordings…' : `${counts[filter]} ${counts[filter] === 1 ? 'recording' : 'recordings'}`}</p>
                </div>
                <NewRecording />
              </div>
              <div className="mw-toolbar">
                <div className="mw-search">
                  <MagnifyingGlass size={16} aria-hidden />
                  <input ref={searchInput} type="search" aria-label="Search recordings" placeholder="Search recordings" value={search} onChange={(event) => setSearch(event.target.value)} />
                  {search && (
                    <button type="button" className="mw-search-clear" aria-label="Clear search" onClick={() => {
                      setSearch('')
                      searchInput.current?.focus()
                    }}><X size={13} weight="bold" aria-hidden /></button>
                  )}
                </div>
                <div className="mw-toolbar-actions">
                  <RecordingSort value={order} onChange={setOrder} />
                  <div className="mw-view-toggle" aria-label="Recording layout" role="group">
                    <button type="button" aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><SquaresFour size={17} /></button>
                    <button type="button" aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={17} /></button>
                  </div>
                </div>
              </div>
              {loading ? <p className="mw-empty" role="status">Loading your library…</p>
                : loadError ? <p className="mw-empty" role="alert">The recording library couldn’t be opened. Reload the page to try again.</p>
                : results.length ? (
                  <ul className="mw-recordings" data-view={view}>
                    {results.map((recording) => (
                      <RecordingCard key={recording.id} recording={recording} manage={() => setModal({ kind: 'manage', recording })} />
                    ))}
                  </ul>
                ) : (
                  <div className="mw-empty">
                    <span className="mw-empty-icon">{query ? <MagnifyingGlass size={29} /> : <VideoCamera size={29} weight="duotone" />}</span>
                    <h2>{query ? 'No matching recordings' : filter === 'all' ? 'Your first recording starts here' : 'No recordings in this view'}</h2>
                    <p>{query ? 'Try another search.' : filter === 'all'
                      ? 'Record your camera, microphone, and slides in one session. Your recordings will appear here.'
                      : 'Choose All recordings to see the rest of your library.'}</p>
                    {!query && filter === 'all' && <NewRecording />}
                  </div>
                )}
            </main>
            <footer className="mw-footer">
              <img className="mw-cpe-logo" src="/brand/cpe-logo.svg" width="1695" height="576" alt="" />
              <span>© {year} Stevens Institute of Technology · All rights reserved</span>
              <button type="button" aria-haspopup="dialog" onClick={() => setModal({ kind: 'about' })}>About Mosaic Web</button>
            </footer>
          </div>
        </div>
      </div>
      {modal?.kind === 'settings' && (
        <Dialog title="Settings" description="Choose how Mosaic Web looks on this device." close={() => setModal(null)}>
          <AppearanceSettings />
          <div className="mw-dialog-actions"><button className="mw-button mw-button-primary" type="button" onClick={() => setModal(null)}>Done</button></div>
        </Dialog>
      )}
      {modal?.kind === 'about' && (
        <Dialog title="About Mosaic Web" description="College of Professional Education · Stevens Institute of Technology" close={() => setModal(null)}>
          <p className="mw-about">Mosaic Web is CPE’s lecture recording workspace. Recordings are stored in the browser profile used to create them.</p>
          <p className="mw-about">© {year} Stevens Institute of Technology. All rights reserved.</p>
          <div className="mw-dialog-actions"><button className="mw-button mw-button-primary" type="button" onClick={() => setModal(null)}>Done</button></div>
        </Dialog>
      )}
      {(modal?.kind === 'manage' || modal?.kind === 'delete') && (
        <RecordingDialog key={modal.kind} recording={modal.recording} deleting={modal.kind === 'delete'}
          close={() => setModal(null)} confirmDelete={() => setModal({ kind: 'delete', recording: modal.recording })}
          saved={(title) => {
            setRecordings((items) => title === null ? items.filter(({ id }) => id !== modal.recording.id)
              : items.map((item) => item.id === modal.recording.id ? { ...item, title } : item))
            setModal(null)
          }}
        />
      )}
    </>
  )
}

function RecordingCard({ recording, manage }: { recording: Recording; manage: () => void }) {
  const review = needsReview(recording)
  return (
    <li className="mw-recording">
      <a className="mw-poster" href={reviewUrl(recording.id)} aria-label={`Review ${recording.title}`}>
        {recording.poster ? <img src={recording.poster} alt="" loading="lazy" /> : <FilmStrip size={34} weight="duotone" />}
        <span className="mw-poster-play"><Play size={17} weight="fill" /></span>
        <span className="mw-duration">{duration(recording.durationMs)}</span>
      </a>
      <div className="mw-recording-details">
        <h2><a href={reviewUrl(recording.id)}>{recording.title}</a></h2>
        <time dateTime={recording.createdAt}>{new Date(recording.createdAt).toLocaleDateString()}</time>
        <span className="mw-status" data-review={review}>
          {review ? <WarningCircle size={14} weight="fill" /> : <CheckCircle size={14} weight="fill" />}
          {recording.recovered ? 'Recovered' : review ? 'Needs review' : 'Ready'}
        </span>
      </div>
      <button className="mw-icon-button mw-recording-menu" aria-label={`Manage ${recording.title}`} aria-haspopup="dialog" type="button" onClick={manage}><DotsThree size={21} weight="bold" /></button>
    </li>
  )
}

function RecordingDialog({ recording, deleting, close, confirmDelete, saved }: {
  recording: Recording; deleting: boolean; close: () => void; confirmDelete: () => void; saved: (title: string | null) => void
}) {
  const [title, setTitle] = useState(recording.title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || (!deleting && !title.trim())) return
    setBusy(true)
    setError(false)
    try {
      if (deleting) await DB.deleteSession(recording.id)
      else await DB.renameSession(recording.id, title.trim())
      saved(deleting ? null : title.trim())
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  return (
    <Dialog title={deleting ? 'Delete recording?' : 'Rename recording'} close={close} busy={busy}
      description={deleting ? `“${recording.title}” and its saved tracks will be removed from this browser.` : 'Change the name shown in your library.'}>
      <form onSubmit={submit}>
        {!deleting && <label className="mw-form-label">Recording name<input value={title} maxLength={160} required onChange={(event) => setTitle(event.target.value)} autoFocus /></label>}
        {error && <p className="mw-error" role="alert">The change couldn’t be saved. Refresh your library and try again.</p>}
        <div className="mw-dialog-actions">
          {!deleting && <button className="mw-button mw-delete-link" type="button" disabled={busy} onClick={confirmDelete}>Delete recording</button>}
          <button className="mw-button" type="button" disabled={busy} onClick={close}>Cancel</button>
          <button className={`mw-button ${deleting ? 'mw-button-danger' : 'mw-button-primary'}`} type="submit" disabled={busy || (!deleting && !title.trim())}>
            {deleting ? 'Delete' : 'Save name'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
