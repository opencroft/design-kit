import * as extHost from '@ext/host'

/**
 * The instance-relative URL of one of this extension's HTTP routes, on the
 * server and the client alike. The host hands it out; a host that predates
 * that serves the routes at a fixed path. Read off the namespace, so the
 * extension still builds against a host with no `routeUrl` export.
 */
export function httpRoute(key = ''): string {
  const { routeUrl } = extHost as { routeUrl?: (path: string) => string }
  return routeUrl ? routeUrl(key) : `/api/ext/local/design-kit/http/${key}`
}
