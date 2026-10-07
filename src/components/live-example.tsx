import { React } from '@ext/host'

import type { PreviewScope } from '../../preview-runtime/protocol'
import { PreviewBlock } from './preview-block'

// An editable example that owns its own code state (used for the Use cases).
export function LiveExample({ code, scope, projectId, component, target }: { code: string; scope: PreviewScope; projectId: string; component?: string; target?: string }) {
  const [current, setCurrent] = React.useState(code)
  React.useEffect(() => {
    setCurrent(code)
  }, [code])
  return <PreviewBlock code={current} onCodeChange={setCurrent} onReset={() => setCurrent(code)} projectId={projectId} scope={scope} component={component} target={target} mode='snippet' />
}
