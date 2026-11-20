import assert from 'node:assert/strict'
import { test } from 'node:test'

import { chatSelection } from './chat-selection.ts'

test('an open component is a readComponent item on the App', () => {
  assert.deepEqual(chatSelection('acme.ui-kit', 'status-badge'), {
    items: [
      {
        kind: 'app',
        app: 'acme.ui-kit',
        action: 'readComponent',
        params: { name: 'status-badge' },
        name: 'status-badge',
        noun: ['component', 'components'],
      },
    ],
  })
})

test('with no component open, the component list is a listComponents page item', () => {
  assert.deepEqual(chatSelection('acme.ui-kit', undefined), {
    items: [
      {
        kind: 'app',
        app: 'acme.ui-kit',
        action: 'listComponents',
        params: {},
        name: 'Components',
        noun: ['page', 'pages'],
      },
    ],
  })
})
