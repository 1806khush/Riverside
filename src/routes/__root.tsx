import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { AppearanceSync, appearanceScript } from '../workspace/appearance'
import workspaceCss from '../workspace/workspace.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Mosaic Web' },
      { name: 'description', content: 'The lecture recording workspace for Stevens College of Professional Education.' },
    ],
    scripts: [{ children: appearanceScript }],
    links: [
      { rel: 'icon', href: '/favicon.png?v=2', type: 'image/png', sizes: '128x128' },
      { rel: 'stylesheet', href: workspaceCss },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppearanceSync />
        {children}
        <Scripts />
      </body>
    </html>
  )
}
