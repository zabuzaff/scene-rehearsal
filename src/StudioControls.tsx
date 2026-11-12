import { useState, type ReactNode } from 'react'
import { Collapsible, Toolbar, Tooltip } from 'radix-ui'

const paths = {
  play: 'M7 4l9 6-9 6z',
  pause: 'M7 5v10m6-10v10',
  reset: 'M5 8a6 6 0 1 1 0 5M5 4v4h4',
  step: 'M5 5l8 5-8 5zm10 0v10',
  chevron: 'm7 4 6 6-6 6',
}

function Glyph({ icon }: { icon: keyof typeof paths }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={paths[icon]}/></svg>
}

export function TransportButton({ label, icon, primary, onClick }: {
  label: string; icon: keyof typeof paths; primary?: boolean; onClick: () => void
}) {
  return <Tooltip.Root>
    <Tooltip.Trigger asChild>
      <Toolbar.Button aria-label={label} className={'transport-button' + (primary ? ' primary' : '')} onClick={onClick}>
        <Glyph icon={icon}/>
      </Toolbar.Button>
    </Tooltip.Trigger>
    <Tooltip.Portal><Tooltip.Content className="studio-tooltip" sideOffset={8}>{label}</Tooltip.Content></Tooltip.Portal>
  </Tooltip.Root>
}

export function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <Collapsible.Root className="studio-disclosure" open={open} onOpenChange={setOpen}>
    <h3><Collapsible.Trigger>{title}<Glyph icon="chevron"/></Collapsible.Trigger></h3>
    <Collapsible.Content forceMount hidden={!open} className="studio-disclosure-content">{children}</Collapsible.Content>
  </Collapsible.Root>
}
