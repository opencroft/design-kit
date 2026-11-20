// What the space's chat is offered about the design project the reader has
// open: one item the host turns into the quote above the composer and the
// block the agent receives, with the App action that reads it. No component
// source travels; the agent reads the current state itself.

import type { Selection } from '@opencroft/client/chat'

/**
 * The chat's selection on the Design Kit App at address `app`: the open
 * component, read with `readComponent`; with none open, the project's
 * component list, read with `listComponents` and quoted as the page
 * "Components" rather than by the project's name, which the quote already
 * gives as the App's.
 */
export function chatSelection(app: string, component: string | undefined): Selection {
  if (component) {
    return {
      items: [
        {
          kind: 'app',
          app,
          action: 'readComponent',
          params: { name: component },
          name: component,
          noun: ['component', 'components'],
        },
      ],
    }
  }
  return {
    items: [{ kind: 'app', app, action: 'listComponents', params: {}, name: 'Components', noun: ['page', 'pages'] }],
  }
}
