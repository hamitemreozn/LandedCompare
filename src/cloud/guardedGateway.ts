/**
 * The gateway business screens receive: every call is bound to the identity
 * the runtime was booted for (Audit A, A-M2).
 *
 * ## Why the runtime needs a guard as well as auth events
 *
 * All tabs of this application share one session in `localStorage`. When
 * another tab signs out, or signs in as somebody else, Supabase relays the
 * change to this tab — but a relayed event is asynchronous, and a request
 * already on its way carries whichever session is stored at the moment it is
 * sent. Without a guard, a screen booted for user A in organisation A could
 * read or write as user B, and render B's answer inside A's context.
 *
 * So every catalogue and identity call is bracketed: the signed-in user is
 * checked before the request and again after the answer arrives. A mismatch
 * — nobody signed in, or someone else — discards the answer, reports the loss
 * so the application reboots from its authentication gate, and throws. The
 * same happens when the server says the membership is gone
 * (`NO_MEMBERSHIP`) or the session was refused (`SESSION_EXPIRED`).
 *
 * Nothing here weakens a server control: RLS still decides every row. This
 * only stops the client from presenting one identity's answer as another's.
 */
import { CloudError, isCloudError } from './errors'
import type { CatalogGateway, DataGateway, IdentityGateway } from './gateway'

export type IdentityLoss = 'SIGNED_OUT' | 'IDENTITY_CHANGED' | 'NO_MEMBERSHIP' | 'SESSION_EXPIRED'

type AnyFunction = (...args: never[]) => Promise<unknown>

export function guardRuntimeGateway(
  gateway: DataGateway,
  expectedUserId: string,
  onLoss: (loss: IdentityLoss) => void,
): DataGateway {
  async function assertIdentity(): Promise<void> {
    let current: string | null
    try {
      current = await gateway.currentUserId()
    } catch (cause) {
      if (isCloudError(cause) && cause.code === 'SESSION_EXPIRED') {
        onLoss('SESSION_EXPIRED')
      }
      throw cause
    }
    if (current === null) {
      onLoss('SIGNED_OUT')
      throw new CloudError('SESSION_EXPIRED', 'nobody is signed in any more')
    }
    if (current !== expectedUserId) {
      onLoss('IDENTITY_CHANGED')
      throw new CloudError('SESSION_EXPIRED', 'a different user is now signed in on this device')
    }
  }

  function guard<F extends AnyFunction>(operation: F): F {
    return (async (...args: Parameters<F>) => {
      await assertIdentity()
      let result: unknown
      try {
        result = await operation(...args)
      } catch (cause) {
        if (isCloudError(cause) && cause.code === 'NO_MEMBERSHIP') onLoss('NO_MEMBERSHIP')
        if (isCloudError(cause) && cause.code === 'SESSION_EXPIRED') onLoss('SESSION_EXPIRED')
        throw cause
      }
      // The answer is only this identity's if the identity is still this one.
      await assertIdentity()
      return result
    }) as F
  }

  function guardAll<T extends object>(target: T): T {
    const guarded: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(target)) {
      guarded[name] = typeof value === 'function' ? guard(value.bind(target) as AnyFunction) : value
    }
    return guarded as T
  }

  return {
    ...gateway,
    identity: guardAll<IdentityGateway>(gateway.identity),
    catalog: guardAll<CatalogGateway>(gateway.catalog),
  }
}
