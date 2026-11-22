import React, { useEffect, useRef, useState } from 'react'
import * as T from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { assetClips, defaultRoom, evaluate, ticksPerSecond, type Manifest } from './model'
import { modelInstance } from './model-instance'
import type { Vec, View, Pick } from './view'

function box(parent: T.Object3D, size: Vec, pos: Vec, color: number) {
  const mesh = new T.Mesh(new T.BoxGeometry(...size), new T.MeshStandardMaterial({ color }))
  mesh.position.set(...pos)
  parent.add(mesh)
  return mesh
}

function primitive(object: Manifest['objects'][number], group: T.Group) {
  if ('size' in object) {
    group.scale.fromArray(object.scale)
    group.rotation.set(...object.rotation, 'XYZ')
    if (object.kind === 'box') box(group, object.size, [0, 0, 0], 0x778d9c)
    else {
      const marker = new T.Mesh(new T.OctahedronGeometry(.5), new T.MeshStandardMaterial({ color: 0xe3ba78 }))
      marker.scale.fromArray(object.size)
      group.add(marker)
    }
  } else if (object.kind === 'researcher') {
    const color = object.id === 'maya' ? 0x315d79 : 0x9a6042
    const torso = new T.Mesh(new T.CapsuleGeometry(.21, .42, 6, 12), new T.MeshStandardMaterial({ color }))
    torso.position.y = 1.12
    group.add(torso)
    const head = new T.Mesh(new T.SphereGeometry(.19, 18, 12), new T.MeshStandardMaterial({ color: 0xc89b78 }))
    head.position.y = 1.62
    group.add(head)
    for (const x of [-.12, .12]) {
      const leg = box(group, [.16, .65, .17], [x, .43, 0], 0x323e42)
      leg.name = x < 0 ? 'left-leg' : 'right-leg'
    }
  } else if (object.kind === 'chair') {
    box(group, [.6, .13, .59], [0, .49, 0], 0x6a7f77)
    box(group, [.58, .47, .11], [0, .76, .29], 0x6a7f77)
    box(group, [.17, .46, .17], [0, .23, 0], 0x364347)
  } else {
    box(group, [1.7, .12, .82], [0, .82, 0], 0xc4a984)
    for (const x of [-.72, .72]) box(group, [.09, .75, .7], [x, .38, 0], 0x777e70)
    box(group, [.72, .45, .1], [0, 1.18, -.16], 0x253439)
    box(group, [.63, .35, .016], [0, 1.18, -.10], object.kind === 'terminal' ? 0x83b9bd : 0xa7b6a7)
    box(group, [.52, .04, .19], [0, .91, .16], 0x43534e)
  }
}

export default function Viewport({ manifest, scenario, tick, view, onView, onPick, pin, onReady }: {
  manifest: Manifest; scenario: string; tick: number; view: View
  onView?: (v: View) => void; onPick?: (p: Pick) => void; pin?: Pick; onReady?: (ready: boolean) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const current = useRef({ scenario, tick, onView, onPick, pin, onReady })
  current.current = { scenario, tick, onView, onPick, pin, onReady }
  const controlsRef = useRef<OrbitControls | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = host.current!
    current.current.onReady?.(false)
    let renderer
    try { renderer = new T.WebGLRenderer({ antialias: true }) }
    catch { setError('3D rendering is unavailable. Use the object list and event timeline to inspect this rehearsal.'); return }
    setError('')
    const scene = new T.Scene()
    scene.background = new T.Color(0x101215)
    scene.add(new T.HemisphereLight(0xffffff, 0x746d60, 2.5))
    const light = new T.DirectionalLight(0xffeed7, 2)
    light.position.set(3, 9, 5)
    scene.add(light)
    const camera = new T.PerspectiveCamera(40, 1, manifest.version === 3 ? .01 : .1, 80)
    camera.position.set(...view.camera)
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.domElement.setAttribute('aria-label', 'Interactive 3D scene')
    element.append(renderer.domElement)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(...view.target)
    if (manifest.version !== 3) {
      controls.maxPolarAngle = Math.PI / 2.1
      controls.maxDistance = 27
      controls.minDistance = 3
    }
    controls.update()
    controlsRef.current = controls
    const report = () => current.current.onView?.({ camera: camera.position.toArray(), target: controls.target.toArray() })
    controls.addEventListener('end', report)
    if (manifest.version !== 3) for (const part of manifest.room ?? defaultRoom) box(scene, part.size, part.position, part.color)
    const grid = new T.GridHelper(8, 16, 0x78817e, 0x8e9990)
    grid.position.y = -.03
    if (manifest.version !== 2) scene.add(grid)
    else { grid.geometry.dispose(); grid.material.dispose() }
    const groups = new Map<string, T.Group>()
    const mixers = new Map<string, { mixer: T.AnimationMixer; actions: Map<string, T.AnimationAction> }>()
    const dispose = (root: T.Object3D) => root.traverse(node => {
      if (node instanceof T.Mesh || node instanceof T.Line || node instanceof T.LineSegments) {
        node.geometry.dispose()
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          for (const value of Object.values(material)) if (value instanceof T.Texture) value.dispose()
          material.dispose()
        }
      }
    })
    const detachedScenes: T.Object3D[] = []
    let active = true
    let pending = manifest.objects.filter(object => object.asset).length
    let rendered = false
    for (const object of manifest.objects) {
      const group = new T.Group()
      group.position.set(...object.position)
      group.userData.id = object.id
      primitive(object, group)
      scene.add(group)
      groups.set(object.id, group)
      const asset = object.asset
      if (asset) {
        new GLTFLoader().load('/api/assets/' + asset.hash, async gltf => {
          if (!active) { dispose(gltf.scene); return }
          const names = assetClips(asset)
          const clips = gltf.animations.filter(clip => names.includes(clip.name))
          if (!names.every(name => clips.some(clip => clip.name === name))) {
            dispose(gltf.scene)
            setError('Mapped clip unavailable for ' + object.label)
            return
          }
          let instance
          try { instance = await modelInstance(gltf, asset.node, object.id, names) }
          catch (error) {
            dispose(gltf.scene)
            if (active) setError((error as Error).message)
            return
          }
          const { model, placement } = instance
          if (!active) {
            if (placement !== gltf.scene) dispose(placement)
            dispose(gltf.scene)
            return
          }
          if (placement !== gltf.scene) detachedScenes.push(gltf.scene)
          for (const child of [...group.children]) { group.remove(child); dispose(child) }
          group.add(placement)
          pending -= 1
          if (clips.length) {
            const mixer = new T.AnimationMixer(model)
            const actions = new Map(clips.map(clip => [clip.name, mixer.clipAction(clip).play()]))
            mixers.set(object.id, { mixer, actions })
          }
        }, undefined, () => { if (active) setError('Mapped asset unavailable for ' + object.label) })
      }
    }
    const addRoute = (points: Vec[], height: number) => {
      const path = new T.Line(new T.BufferGeometry().setFromPoints(points.map(([x, y, z]) => new T.Vector3(x, y + height, z))),
        new T.LineBasicMaterial({ color: manifest.version === 3 ? 0x9bbcff : 0x4a7789 }))
      scene.add(path)
      return path
    }
    const routes = manifest.version === 3 ? manifest.scenarios.flatMap(s => s.events.flatMap(event =>
      event.route ? [{ scenario: s.id, tick: event.tick, line: addRoute(event.route, 0) }] : [])) : []
    if (manifest.version !== 3) addRoute(manifest.version === 1 ? manifest.route : manifest.outbound.map(p => p.position), .025)
    const draftBounds = manifest.version === 3
      ? new T.Box3().setFromObject(scene).getBoundingSphere(new T.Sphere())
      : undefined
    const marker = new T.Mesh(new T.SphereGeometry(.11, 12, 8), new T.MeshBasicMaterial({ color: 0xabbcff }))
    scene.add(marker)
    const resize = new ResizeObserver(() => {
      camera.aspect = element.clientWidth / Math.max(1, element.clientHeight)
      // Preserve room for the cutaway's outer walls in narrow and split viewports.
      const minimumHorizontalFov = T.MathUtils.degToRad(52)
      const verticalFov = 2 * Math.atan(Math.tan(minimumHorizontalFov / 2) / Math.max(.1, camera.aspect))
      camera.fov = Math.max(40, T.MathUtils.radToDeg(verticalFov))
      camera.updateProjectionMatrix()
      renderer.setSize(element.clientWidth, element.clientHeight)
    })
    resize.observe(element)
    let start: [number, number] = [0, 0]
    const down = (event: PointerEvent) => { start = [event.clientX, event.clientY] }
    const pick = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 4) return
      const rect = renderer.domElement.getBoundingClientRect()
      const ray = new T.Raycaster()
      ray.setFromCamera(new T.Vector2(2 * (event.clientX - rect.left) / rect.width - 1, 1 - 2 * (event.clientY - rect.top) / rect.height), camera)
      const hit = ray.intersectObjects([...groups.values()], true)[0]
      if (hit) {
        let node: T.Object3D | null = hit.object
        while (node && groups.get(node.userData.id) !== node) node = node.parent
        if (node) current.current.onPick?.({ object: node.userData.id, point: node.worldToLocal(hit.point).toArray() })
      } else {
        const point = ray.ray.intersectPlane(new T.Plane(new T.Vector3(0, 1, 0)), new T.Vector3())
        if (point) current.current.onPick?.({ point: point.toArray() })
      }
    }
    renderer.domElement.addEventListener('pointerdown', down)
    renderer.domElement.addEventListener('pointerup', pick)
    let contextAvailable = true
    const contextLost = () => {
      contextAvailable = false
      rendered = false
      current.current.onReady?.(false)
      setError('3D rendering was interrupted. Reload this revision before approving.')
    }
    renderer.domElement.addEventListener('webglcontextlost', contextLost)
    renderer.setAnimationLoop(() => {
      const frame = current.current
      const state = evaluate(manifest, frame.scenario, frame.tick)
      for (const route of routes) route.line.visible = route.scenario === frame.scenario && route.tick <= frame.tick
      const walking = state.activity.startsWith('Walking') || state.activity.startsWith('Returning')
      if (manifest.version === 1) {
        const responder = groups.get(manifest.responder)
        if (responder) {
          const next = evaluate(manifest, frame.scenario, frame.tick + 1).position
          responder.position.fromArray(state.position)
          responder.rotation.y = walking ? Math.atan2(next[0] - state.position[0], next[2] - state.position[2]) : Math.PI
        }
      }
      for (const actor of state.actors) {
        const group = groups.get(actor.id)
        group?.position.fromArray(actor.position)
        if (group) group.rotation.y = actor.heading
      }
      for (const object of manifest.objects) {
        const actor = state.actors.find(actor => actor.id === object.id)
        const moving = actor ? actor.activity === 'outbound' || actor.activity === 'return' :
          manifest.version !== 3 && object.id === manifest.responder && walking
        const group = groups.get(object.id)
        for (const leg of group?.children.filter(node => node.name.endsWith('-leg')) ?? []) {
          leg.rotation.x = moving ? Math.sin(frame.tick * .6) * (leg.name === 'left-leg' ? .45 : -.45) : 0
        }
        const animation = mixers.get(object.id)
        const asset = object.asset
        if (manifest.version === 3 || !animation || !asset) continue
        const clip = 'clip' in asset ? asset.clip : actor && 'clips' in asset && asset.clips?.[actor.activity]
        const seconds = (actor?.clipTick ?? (object.id !== manifest.responder || walking ? frame.tick : 0)) / ticksPerSecond
        for (const [name, action] of animation.actions) {
          action.enabled = name === clip
          action.paused = true
          const duration = action.getClip().duration
          action.time = duration > 0 ? seconds % duration : 0
        }
        animation.mixer.update(0)
      }
      marker.visible = Boolean(frame.pin)
      if (frame.pin) {
        const anchor = frame.pin.object ? groups.get(frame.pin.object) : undefined
        const point = new T.Vector3(...frame.pin.point)
        marker.position.copy(anchor ? anchor.localToWorld(point) : point)
      }
      if (draftBounds) {
        const far = Math.max(80, camera.position.distanceTo(draftBounds.center) + draftBounds.radius + 1)
        if (far !== camera.far) {
          camera.far = far
          camera.updateProjectionMatrix()
        }
      }
      renderer.render(scene, camera)
      if (!rendered && contextAvailable && pending === 0) {
        rendered = true
        current.current.onReady?.(true)
      }
    })
    return () => {
      active = false
      renderer.setAnimationLoop(null)
      resize.disconnect()
      renderer.domElement.removeEventListener('webglcontextlost', contextLost)
      controls.dispose()
      controlsRef.current = null
      for (const { mixer } of mixers.values()) mixer.stopAllAction()
      for (const detached of detachedScenes) dispose(detached)
      dispose(scene)
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [manifest])
  useEffect(() => {
    const controls = controlsRef.current
    if (controls) {
      controls.object.position.fromArray(view.camera)
      controls.target.fromArray(view.target)
      controls.update()
    }
  }, [view])
  return <div className="viewport"><div className="canvas" ref={host}/>{error && <p className="viewport-error" role="status">{error}</p>}</div>
}
