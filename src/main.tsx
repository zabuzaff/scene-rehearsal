import React, { useEffect, useLayoutEffect, useState, useCallback, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Dialog, Slider, Tabs, Toolbar, Tooltip } from 'radix-ui'
import { evaluate, missingActivities, missingAsset, ticksPerSecond, type Manifest } from './model'
import { lazy, Suspense, useRef } from 'react'
import { defaultView, type View, type Pick } from './view'
const Viewport = lazy(() => import('./Viewport'))
import { StudioSelect } from './StudioSelect'
import { Disclosure, TransportButton } from './StudioControls'
import './style.css'

type Summary = { digest: string; parent: string | null; title: string }
type Note = View & { id: number; revision: string; scenario: string; tick: number; end?: number; text: string; resolved: boolean } & Partial<Pick>
type Revision = Summary & { scene: Manifest; sources: { object: string; project: string; asset: string; revision: string; hash: string }[]; owner: boolean; notes: Note[]; approvals: { kind: string; at: string }[] }

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/' + url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw Error(data.error)
  return data
}
const activityLabels = { quiet: 'Quiet work', outbound: 'Outbound travel', inspect: 'Terminal inspection', return: 'Return travel' }
const time = (tick: number) => (tick / ticksPerSecond).toFixed(1) + ' s'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

function Shell() {
  const location = useLocation()
  const navigate = useNavigate()
  const [revisions, setRevisions] = useState<Summary[]>([])
  const activeRevision = location.pathname.split('/')[2] ?? ''
  const [owner, setOwner] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const latestLibraryRequest = useRef(0)
  const refreshLibrary = useCallback(() => {
    const request = ++latestLibraryRequest.current
    void api<{ owner: boolean; revisions: Summary[] }>('library').then(data => {
      if (request !== latestLibraryRequest.current) return
      setOwner(data.owner)
      setRevisions(data.revisions)
    }).catch(() => {})
  }, [])
  useEffect(refreshLibrary, [location.pathname, refreshLibrary])
  const refreshOnOpen = (isOpen: boolean) => { if (isOpen) refreshLibrary() }
  async function enroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    try {
      await api('enroll', { code: new FormData(event.currentTarget).get('code') })
      latestLibraryRequest.current += 1
      setOwner(true)
      setOpen(false)
    } catch (err) { setError(message(err)) }
  }
  return <Tooltip.Provider>
    <header className="shell"><Link viewTransition className="brand" to="/"><span className="brand-mark" aria-hidden/><span>Scene Rehearsal<span className="brand-period">.</span></span></Link>
      <span className="shell-divider" aria-hidden="true"/>
      <nav aria-label="Primary"><StudioSelect label="Open revision" variant="project" value={activeRevision} onOpenChange={refreshOnOpen}
        options={[{ value: '', label: 'Rehearsal library' }, ...revisions.map(rev => ({ value: rev.digest, label: rev.title, description: rev.digest.slice(0, 10) }))]}
        onChange={id => navigate(id ? '/revision/' + id + '/first' : '/', { viewTransition: true })}/></nav>
      {owner ? <span className="session">Owner session</span> : <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild><button>Unlock review</button></Dialog.Trigger>
        <Dialog.Portal><Dialog.Overlay className="overlay"/><Dialog.Content className="dialog">
          <Dialog.Title>Unlock owner review</Dialog.Title>
          <Dialog.Description>Press Enter in the terminal running Scene Rehearsal. Enter the one-time code shown there.</Dialog.Description>
          <form onSubmit={enroll}><label>Owner code<input name="code" inputMode="numeric" pattern="[0-9]{8}" required autoComplete="one-time-code"/></label>
            {error && <p role="alert">{error}</p>}<div className="actions"><Dialog.Close asChild><button type="button">Cancel</button></Dialog.Close><button className="primary">Unlock</button></div></form>
        </Dialog.Content></Dialog.Portal>
      </Dialog.Root>}
    </header>
    <main key={location.pathname.split('/').slice(0, 3).join('/')} className="page">
      <Routes><Route path="/" element={<Library/>}/><Route path="/revision/:digest/:scenario" element={<Workbench owner={owner} revisions={revisions} onPickerOpen={refreshOnOpen}/>}/>
        <Route path="*" element={<section className="library"><h1>Page not found</h1><Link viewTransition to="/">Return to library</Link></section>}/></Routes>
    </main>
    <footer>Scene Rehearsal <span>Local review workspace</span></footer>
  </Tooltip.Provider>
}

function Library() {
  const [data, setData] = useState<{ head: string; revisions: Summary[] }>()
  const [error, setError] = useState('')
  useEffect(() => { api<typeof data>('library').then(setData).catch(err => setError(message(err))) }, [])
  return <section className="library"><h1>Rehearsal library</h1>
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading rehearsals…</p>}
    {data && !data.revisions.length && <p>Publish a revision with the author CLI to open it here.</p>}
    {data && <ul className="revision-list">{data.revisions.map(rev => <li key={rev.digest}>
      <Link viewTransition to={'/revision/' + rev.digest + '/first'}><strong>{rev.title}</strong><span>{rev.digest.slice(0, 10)}{rev.digest === data.head ? ' · Current revision' : ''}</span><span aria-hidden>→</span></Link>
    </li>)}</ul>}
  </section>
}

function Workbench({ owner, revisions, onPickerOpen }: {
  owner: boolean; revisions: Summary[]; onPickerOpen: (open: boolean) => void
}) {
  const { digest = '', scenario: routeScenario = '' } = useParams()
  const { search } = useLocation()
  const navigate = useNavigate()
  const [rev, setRev] = useState<Revision>()
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [tick, setTick] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState('1')
  const [view, setView] = useState<View>(defaultView)
  const [pick, setPick] = useState<Pick>()
  const [readyScene, setReadyScene] = useState<Manifest>()
  const [draftPin, setDraftPin] = useState<(View & Partial<Pick> & { scenario: string; tick: number })>()
  const [tab, setTab] = useState('events')
  const [old, setOld] = useState<Revision>()
  const [restore, setRestore] = useState<Note>()
  const [approval, setApproval] = useState<'blockout' | 'final' | null>(null)
  const [exportDigest, setExportDigest] = useState('')
  const approvalTrigger = useRef<HTMLButtonElement>(null)
  function requestApproval(event: React.MouseEvent<HTMLButtonElement>, kind: 'blockout' | 'final') {
    approvalTrigger.current = event.currentTarget
    setApproval(kind)
  }
  const refresh = async () => setRev(await api<Revision>('revision/' + digest))

  useEffect(() => {
    let live = true
    api<Revision>('revision/' + digest).then(data => { if (live) setRev(data) }).catch(err => { if (live) setLoadError(message(err)) })
    return () => { live = false }
  }, [digest])
  useEffect(() => {
    const id = new URLSearchParams(search).get('note')
    const note = id && rev?.notes.find(n => String(n.id) === id && n.revision === digest)
    if (note) {
      setTab('notes')
      setRestore(note)
    }
  }, [search, rev, digest])
  const scene = rev?.scene
  const scenario = scene?.scenarios.find(s => s.id === routeScenario) ?? scene?.scenarios[0]
  useEffect(() => {
    if (routeScenario === 'first' && scenario) navigate('/revision/' + digest + '/' + scenario.id, { replace: true })
  }, [routeScenario, scenario, navigate, digest])
  useLayoutEffect(() => {
    setPlaying(false)
    setTick(0)
    setPick(undefined)
    setDraftPin(undefined)
  }, [scenario?.id])
  useEffect(() => {
    if (restore && scenario?.id === restore.scenario) {
      setPlaying(false)
      setTick(restore.tick)
      setView({ camera: restore.camera, target: restore.target })
      setPick(restore.point ? { point: restore.point, object: restore.object } : undefined)
      setDraftPin({ scenario: restore.scenario, tick: restore.tick, camera: restore.camera, target: restore.target, object: restore.object, point: restore.point })
      setRestore(undefined)
    }
  }, [restore, scenario?.id])
  useEffect(() => {
    if (!playing || !scene) return
    const started = performance.now()
    const start = tick
    let id = 0
    const frame = (now: number) => {
      const next = Math.min(scene.duration, start + Math.floor((now - started) / 1000 * ticksPerSecond * Number(speed)))
      setTick(next)
      if (next < scene.duration) id = requestAnimationFrame(frame)
      else setPlaying(false)
    }
    id = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(id)
    // The clock starts from the current tick only when playback or speed changes.
  }, [playing, speed, scene?.duration])

  if (loadError) return <section className="library"><h1>Rehearsal unavailable</h1><p role="alert">{loadError}</p><Link viewTransition to="/">Return to library</Link></section>
  if (!rev || !scene || !scenario) return <p role="status" className="library">Loading rehearsal…</p>
  if (routeScenario !== 'first' && !scene.scenarios.some(s => s.id === routeScenario)) {
    return <section className="library"><h1>Scenario unavailable</h1><Link viewTransition to={'/revision/' + digest + '/' + scenario.id}>Open {scenario.label}</Link></section>
  }

  const state = evaluate(scene, scenario.id, tick)
  const setTime = (value: number) => { setPlaying(false); setTick(Math.min(scene.duration, Math.max(0, value))) }
  const changeScenario = (id: string) => navigate('/revision/' + digest + '/' + id, { viewTransition: true })
  const act = async (work: () => Promise<void>) => {
    setError('')
    setStatus('')
    try { await work() } catch (err) { setError(message(err)) }
  }
  const pinContext = { scenario: scenario.id, tick, ...view, ...pick }
  const noteContext = draftPin ?? pinContext
  const capturePin = () => {
    setPlaying(false)
    setDraftPin(pinContext)
  }
  const selectTab = (value: string) => {
    if (value === 'notes' && !draftPin) capturePin()
    if (tab === 'notes' && value !== 'notes') setDraftPin(undefined)
    setTab(value)
  }
  const saveNote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    void act(async () => {
      const end = fields.get('end')
      await api('revision/' + digest + '/note', {
        ...noteContext, end: end === '' ? undefined : Math.round(Number(end) * ticksPerSecond),
        text: fields.get('note'),
      })
      form.reset()
      setDraftPin(undefined)
      await refresh()
      setStatus('Feedback saved.')
    })
  }
  const openNote = (note: Note) => {
    if (note.revision !== digest) {
      navigate('/revision/' + note.revision + '/' + note.scenario + '?note=' + note.id, { viewTransition: true })
      return
    }
    setRestore(note)
    if (scenario.id !== note.scenario) changeScenario(note.scenario)
  }
  const mapped = scene.objects.filter(object => object.asset).length
  const missing = scene.objects.filter(missingAsset)
  const finalReady = Boolean(scene.room && !missing.length && readyScene === scene)
  return <section className="workbench">
    <div className="workbench-header"><div><h1>{scene.title}</h1>
      <p className="revision">Revision <code>{digest.slice(0, 10)}</code> <span>·</span> {rev.approvals.some(a => a.kind === 'final') ? scene.room ? 'Approved for implementation' : 'Legacy approval · republish to export' : rev.approvals.length ? 'Blockout approved' : mapped ? 'Asset review' : 'Blockout'}</p></div>
      <div className="actions"><StudioSelect label="Scenario" value={scenario.id} options={scene.scenarios.map(item => ({ value: item.id, label: item.label }))} onChange={changeScenario}/>
        <StudioSelect label="Compare revision" onOpenChange={onPickerOpen} value={old?.digest ?? ''} options={[{ value: '', label: 'Compare revision', description: 'Focus on one revision' }, ...revisions.filter(r => r.digest !== digest).map(r => ({ value: r.digest, label: r.digest.slice(0, 10), description: r.title }))]} onChange={id => {
          if (!id) setOld(undefined)
          else void act(async () => setOld(await api<Revision>('revision/' + id)))
        }}/></div>
    </div>
    <div className="workspace">
      <div className="stage">
        <Suspense fallback={<p role="status">Loading 3D viewport…</p>}><div className={old ? 'view-pair' : 'view-single'}>
          {old && <div><p className="view-label">Compared revision <code>{old.digest.slice(0, 10)}</code></p><Viewport manifest={old.scene} scenario={scenario.id} tick={Math.min(tick, old.scene.duration)} view={view}/></div>}
          <div>{old && <p className="view-label">Current revision</p>}<Viewport manifest={scene} scenario={scenario.id} tick={tick} view={view} onView={setView} onReady={ready => setReadyScene(ready ? scene : undefined)} pin={pick} onPick={value => { setPick(value); setTab('objects') }}/></div>
        </div>
        </Suspense><div className="timeline">
          <Toolbar.Root aria-label="Playback controls" className="transport">
            <TransportButton label="Reset" icon="reset" onClick={() => setTime(0)}/>
            <TransportButton label={playing ? 'Pause' : 'Play'} icon={playing ? 'pause' : 'play'} primary onClick={() => { if (tick === scene.duration) setTick(0); setPlaying(!playing) }}/>
            <TransportButton label="Step" icon="step" onClick={() => setTime(tick + 1)}/>
            <StudioSelect value={speed} label="Playback speed" options={['0.5', '1', '2'].map(value => ({ value, label: value + '×' }))} onChange={setSpeed}/>
            <output>{time(tick)} / {time(scene.duration)}</output>
          </Toolbar.Root>
          <Slider.Root className="slider" value={[tick]} max={scene.duration} step={1} onValueChange={([value]) => setTime(value)}>
            <Slider.Track className="track"><Slider.Range className="range"/></Slider.Track><Slider.Thumb className="thumb" aria-label="Playback time" aria-valuetext={time(tick)}/>
          </Slider.Root>
          <div className="markers">{scenario.events.map(event => <button key={event.id} onClick={() => { setTime(event.tick); setTab('events') }}>{time(event.tick)} · {event.feed}</button>)}</div>
        </div>
      </div>
      <aside className="inspector" aria-label="Scene inspector">
        <Tabs.Root value={tab} onValueChange={selectTab}>
          <Tabs.List className="tabs" aria-label="Inspect"><Tabs.Trigger value="events">Events</Tabs.Trigger><Tabs.Trigger value="objects">Objects</Tabs.Trigger><Tabs.Trigger value="notes">Feedback</Tabs.Trigger></Tabs.List>
          <Tabs.Content value="events" className="pane"><h2>{scenario.label}</h2><p className="activity">{state.activity}</p>
            {scene.version === 2 && <dl className="scene-status">
              {state.actors.map(actor => <div key={actor.id}><dt>{scene.objects.find(o => o.id === actor.id)?.label}</dt><dd>{actor.activity === 'quiet' ? scene.actors.find(a => a.id === actor.id)?.task : state.activity}</dd></div>)}
              {state.evidence.map(item => <div key={item.station}><dt>{scene.objects.find(o => o.id === item.station)?.label}</dt><dd>{item.freshness} · {item.health}</dd></div>)}
            </dl>}
            <p>Repeated events from the same feed merge during an active response.</p>
            {state.trace.length ? <ol className="event-list">{state.trace.map(event => <li key={event.id}><button onClick={() => setTime(event.tick)}>{time(event.tick)}</button><div>{event.result}<small>{event.feed}</small></div></li>)}</ol> : <p className="muted">No events have arrived at this point.</p>}
          </Tabs.Content>
          <Tabs.Content value="objects" className="pane"><h2>Scene objects</h2><ul className="objects">
            {scene.objects.map(object => {
              const asset = object.asset
              const source = rev.sources.find(source => source.object === object.id)
              const clips = asset && 'clips' in asset ? Object.entries(asset.clips ?? {}) : []
              const missing = missingActivities(object)
              const selected = pick?.object === object.id
              return <li key={object.id}>
                <button aria-pressed={selected} onClick={() => setPick({ object: object.id, point: [0, .6, 0] })}>{object.label}</button>
                {missing.length > 0 && <p className="asset-id">Missing clips for {missing.map(beat => activityLabels[beat]).join(', ')}.</p>}
                {selected && asset && <div className="asset-id">
                  <p>Model <code>{asset.hash}</code>
                    {source && <><br/>Mesh Foundry {source.project} / {source.asset} / {source.revision}</>}
                  </p>
                  {'clip' in asset ? <p>Clip {asset.clip}</p> :
                    clips.length > 0 ? <dl className="scene-status">{clips.map(([beat, clip]) =>
                      <div key={beat}><dt>{activityLabels[beat as keyof typeof activityLabels]}</dt><dd>{clip}</dd></div>)}</dl> :
                      !missing.length && <p>Static model</p>}
                </div>}
              </li>
            })}</ul>
            {pick && <><p>{pick.object ? scene.objects.find(o => o.id === pick.object)?.label : 'Floor position'} · {pick.point.map(value => value.toFixed(2)).join(', ')}</p><button onClick={() => { capturePin(); setTab('notes') }}>Pin feedback</button></>}
          </Tabs.Content>
          <Tabs.Content value="notes" className="pane"><h2>Review feedback</h2>
            {owner && <form onSubmit={saveNote} onFocus={() => { if (!draftPin) capturePin() }}>
              <p className="pin-summary">Pin at {time(noteContext.tick)}{noteContext.object ? ' on ' + scene.objects.find(o => o.id === noteContext.object)?.label : ''}</p>
              <label>Adjustment<textarea name="note" required maxLength={2000} rows={3}/></label>
              <label>End time in seconds (optional)<input type="number" name="end" min={noteContext.tick / ticksPerSecond} max={scene.duration / ticksPerSecond} step=".1"/></label>
              <button className="primary">Save feedback</button>
            </form>}
            <ul className="notes">{rev.notes.map(note => <li key={note.id}>
              <button onClick={() => openNote(note)}>{time(note.tick)}{note.end !== undefined ? '–' + time(note.end) : ''} · {note.resolved ? 'Resolved' : 'Open'}</button>
              <p>{note.text}</p>{owner && <button onClick={() => void act(async () => {
                await api('note/' + note.id + '/decision', { resolved: !note.resolved })
                await refresh()
              })}>{note.resolved ? 'Reopen' : 'Resolve'}</button>}
            </li>)}</ul>
          </Tabs.Content>
        </Tabs.Root>
        <section className="handoff"><h2>Revision handoff</h2>
          {missing.length > 0 && <p className="muted">Required model or clip missing for {missing.map(o => o.label).join(', ')}.</p>}
          {!scene.room && <p className="muted">Publish a new revision to include the room in final approval.</p>}
          {scene.room && !missing.length && !finalReady && <p className="muted">Final approval requires a rendered scene with all mapped models and clips.</p>}
          {owner && <><Disclosure title="Import Mesh Foundry model"><form onSubmit={event => {
            event.preventDefault()
            const fields = new FormData(event.currentTarget)
            void act(async () => {
              const file = fields.get('bundle')
              if (!(file instanceof File) || !file.size || file.size > 180_000_000) throw Error('Choose a Mesh Foundry bundle under 180 MB.')
              const asset = fields.get('asset')
              const expected = scene.version === 2 ? { asset, project: fields.get('project'),
                revision: fields.get('revision'), hash: fields.get('hash') } : undefined
              const result = await api<{ hash: string; sourceKey: string; clips: string[] }>('assets/import', { asset, expected, bundle: JSON.parse(await file.text()) })
              setStatus('Imported ' + result.hash + (scene.version === 2 ? '. Source key: ' + result.sourceKey : '') + '. Clips: ' + result.clips.join(', ') + '. Publish a revision mapping the model through the CLI.')
            })
          }}><label>Project bundle<input type="file" name="bundle" accept=".json" required/></label><label>Asset ID<input name="asset" required/></label>{scene.version === 2 && <>
              <p>Enter the exact accepted model details from the owner-controlled Mesh Foundry project record.</p>
              <label>Mesh Foundry project ID<input name="project" required/></label>
              <label>Accepted model revision ID<input name="revision" required/></label>
              <label>GLB SHA-256<input name="hash" pattern="[0-9a-f]{64}" required/></label>
            </>}<button>Import model</button></form></Disclosure>
          <div className="actions"><button onClick={event => requestApproval(event, 'blockout')}>Approve blockout</button><button disabled={!finalReady} onClick={event => requestApproval(event, 'final')}>Approve final</button></div>
          {scene.room && rev.approvals.some(a => a.kind === 'final') && <button className="primary" onClick={() => void act(async () => {
            const result = await api<{ digest: string; package: unknown }>('revision/' + digest + '/export', {})
            const url = URL.createObjectURL(new Blob([JSON.stringify(result.package)], { type: 'application/json' }))
            const link = document.createElement('a')
            link.href = url
            link.download = 'rehearsal-' + digest.slice(0, 10) + '.json'
            link.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
            setExportDigest(result.digest)
          })}>Export approved package</button>}</>}
          {exportDigest && <label>Confirm this digest separately with the consumer<input readOnly value={exportDigest}/></label>}
        </section>
        {status && <p className="notice" role="status">{status}</p>}
        {error && <p className="notice error" role="alert">{error}</p>}
      </aside>
    </div>
    <Dialog.Root open={Boolean(approval)} onOpenChange={open => { if (!open) setApproval(null) }}>
      <Dialog.Portal><Dialog.Overlay className="overlay"/><Dialog.Content className="dialog" onCloseAutoFocus={event => { event.preventDefault(); approvalTrigger.current?.focus() }}>
        <Dialog.Title>{approval === 'final' ? 'Approve for implementation?' : 'Approve blockout?'}</Dialog.Title>
        <Dialog.Description>Your approval applies to revision {digest.slice(0, 10)}.</Dialog.Description>
        <div className="actions"><Dialog.Close asChild><button>Cancel</button></Dialog.Close><button className="primary" disabled={approval === 'final' && !finalReady} onClick={() => void act(async () => {
          const kind = approval
          setApproval(null)
          await api('revision/' + digest + '/approve', { kind })
          await refresh()
          setStatus('Approval recorded.')
        })}>Confirm approval</button></div>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </section>
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><Shell/></BrowserRouter>)
