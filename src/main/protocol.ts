import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import { resolveInsideDist } from './pathGuard';

/**
 * The `app://` scheme (BUILD-SPEC.md §18.1.1). The packaged renderer is
 * served through this instead of `file://` because Phaser's tilemap/atlas
 * fetches (added in a later milestone) are blocked on `file://` origins when
 * `webSecurity` is on — a failure that only shows up after packaging, so it
 * is proven here at M0 instead of being discovered late.
 */
export const APP_SCHEME = 'app';

/**
 * Must be called before `app.whenReady()`. Privileges cannot be changed once
 * the app is ready.
 */
export function registerAppProtocolPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Must be called after `app.whenReady()`. Serves the built renderer (and
 * nothing else — `distRoot` should point at `dist/renderer`, not `dist/`)
 * through the `app://` scheme.
 */
export function registerAppProtocolHandler(distRoot: string): void {
  protocol.handle(APP_SCHEME, (req) => {
    const resolved = resolveInsideDist(req.url, distRoot);
    if (resolved === null) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}
