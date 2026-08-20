/** Small currentColor icons; labels live on their owning controls. */
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Icon(props: IconProps): React.ReactElement {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props} />
}

export function ServerIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" /></Icon>
}

export function PlusIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><path d="M12 5v14M5 12h14" /></Icon>
}

export function RefreshIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></Icon>
}

export function ChevronIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><path d="m9 18 6-6-6-6" /></Icon>
}

export function FolderIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></Icon>
}

export function KeyIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><circle cx="8" cy="12" r="4" /><path d="m12 12 9-9M16 8l3 3M18 6l3 3" /></Icon>
}

export function TerminalIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></Icon>
}

export function TrashIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></Icon>
}

export function CheckIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><path d="m5 12 4 4L19 6" /></Icon>
}

export function AlertIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><path d="M12 3 2.8 19h18.4Z" /><path d="M12 9v4M12 17h.01" /></Icon>
}

export function ExternalIcon(props: IconProps): React.ReactElement {
  return <Icon {...props}><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></Icon>
}
