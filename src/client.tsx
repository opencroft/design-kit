import { defineExtension } from '@ext/host'

import { DesignKitAppView } from './design-kit-app-view'

export default defineExtension({
  manifest: {},
  provides: {
    apps: [
      {
        type: 'design-kit',
        title: 'Design Kit',
        description: 'A design project: a categorized component & hook library with live previews.',
        icon: 'Palette',
        component: DesignKitAppView,
      },
    ],
  },
})
