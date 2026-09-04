import type { ReactNode } from 'react'
import { ExternalLink as ExternalLinkIcon } from 'lucide-react'

export default function ExternalLink({ href, children, icon = false, className = '' }: { href: string; children: ReactNode; icon?: boolean; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={`link-quiet ${icon ? 'inline-flex items-center gap-1' : ''} ${className}`}>
      {children}
      {icon && <ExternalLinkIcon className="size-3 shrink-0 opacity-70" />}
    </a>
  )
}
