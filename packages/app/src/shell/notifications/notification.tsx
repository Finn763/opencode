import { createSignal, onCleanup } from "solid-js"
import { Schema } from "effect"
import type { SessionError } from "@opencode/schema/session-error"
import type { SessionInfo } from "@opencode/client/promise"
import type { ServerSDK } from "@/runtime/server/client"
import type { Data } from "@opencode/client/solid"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { Persist, persisted, removePersisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { playSoundById } from "@/shell/notifications/sound"
import type { createNotificationCoordinator } from "@/shell/notifications/coordinator"
import { ServerConnection } from "@/runtime/server/registry"
import { sessionIDHasOpenTab, useTabs } from "@/shell/tabs/tabs"
import { useServer } from "@/runtime/server/current"

type NotificationTabs = Pick<ReturnType<typeof useTabs>, "addSessionTab" | "rememberSessionRoute" | "select">

export function openNotificationSession(tabs: NotificationTabs, server: ServerConnection.Key, sessionID: string) {
  const tab = tabs.addSessionTab({ server, sessionId: sessionID })

  if (tab.type !== "session") return
  tabs.rememberSessionRoute(tab, sessionID)
  tabs.select(tab)
}

/** A session is unread when its latest terminal execution is newer than the last one any client viewed. */
export function isSessionUnread(session?: Pick<SessionInfo, "time">) {
  const time = session?.time

  return time?.idle !== undefined && (time.viewed === undefined || time.idle > time.viewed)
}

// The list Desktop kept before unread state moved to the server; read once to carry its viewed state over.
const LegacyNotificationStore = Persistence.struct({
  list: Schema.optional(
    Persistence.array(Persistence.struct({ session: Schema.optional(Schema.String), viewed: Schema.Boolean })),
  ),
})

const LEGACY_MIGRATION_LIMIT = 100

const VIEW_RETRY_DELAY = 250

const VIEW_RETRY_MAX_DELAY = 5_000

export function createServerNotificationState(input: {
  sdk: ServerSDK
  data: Data
  key: ServerConnection.Key
  coordinator: ReturnType<typeof createNotificationCoordinator>
}) {
  const platform = usePlatform()
  const settings = useSettings()
  const language = useLanguage()
  const tabs = useTabs()
  const disposed = { value: false }
  // Idle watermarks already reported per root session, so reactive re-runs don't re-post them.
  const acknowledged = new Map<string, number>()
  // A failed view report re-runs the tracking caller with backoff, like the TUI.
  const [viewRetry, setViewRetry] = createSignal(0)
  let viewRetryTimer: ReturnType<typeof setTimeout> | undefined
  let viewRetryAttempt = 0
  onCleanup(() => clearTimeout(viewRetryTimer))

  // Unread state now lives on the server. Desktop never reported views, so the server still holds sessions read here
  // as unread: mark the most recent ones viewed unless the old list had them unread, then drop the list.
  // A failed listing keeps the list so the next start retries.
  const legacyTarget = Persist.serverGlobal(input.sdk.scope, "notification")
  const [legacy, , , legacyReady] = persisted(legacyTarget, LegacyNotificationStore, {}, platform)

  void Promise.resolve(legacyReady.promise)
    .then(async () => {
      const list = legacy.list

      if (list) {
        const unseen = new Set(list.flatMap((item) => (!item.viewed && item.session ? [item.session] : [])))
        const page = await input.sdk.api.session.list({ limit: LEGACY_MIGRATION_LIMIT, order: "desc", parentID: null })

        await Promise.allSettled(
          page.data.flatMap((session) =>
            session.time.idle !== undefined && isSessionUnread(session) && !unseen.has(session.id)
              ? [input.sdk.api.session.view({ sessionID: session.id, idle: session.time.idle })]
              : [],
          ),
        )
      }

      removePersisted(legacyTarget, platform)
    })
    .catch(() => undefined)

  const unreadRoots = (directory: string) =>
    input.data.session
      .list()
      .filter(
        (session) =>
          !session.parentID &&
          session.time.archived === undefined &&
          session.location.directory === directory &&
          isSessionUnread(session),
      )

  const view = (sessionID: string) => {
    viewRetry()
    const root = input.data.session.root(sessionID)
    const session = input.data.session.get(root)
    const idle = session?.time.idle

    if (idle === undefined || !isSessionUnread(session) || acknowledged.get(root) === idle) return
    acknowledged.set(root, idle)
    void input.sdk.api.session.view({ sessionID: root, idle }).then(
      () => {
        clearTimeout(viewRetryTimer)
        viewRetryTimer = undefined
        viewRetryAttempt = 0
      },
      () => {
        if (acknowledged.get(root) !== idle) return
        acknowledged.delete(root)

        if (viewRetryTimer) return

        const delay = Math.min(VIEW_RETRY_DELAY * 2 ** viewRetryAttempt, VIEW_RETRY_MAX_DELAY)
        viewRetryAttempt++
        viewRetryTimer = setTimeout(() => {
          viewRetryTimer = undefined
          setViewRetry((value) => value + 1)
        }, delay)
      },
    )
  }

  // Loading the session keeps a background completion visible in the server-derived unread state.
  const lookup = async (sessionID: string) => {
    const session = input.data.session.get(sessionID)

    if (session) return session

    return input.data.session
      .sync(sessionID)
      .then(() => input.data.session.get(sessionID))
      .catch(() => undefined)
  }

  const handleSessionIdle = (sessionID: string, eventID: string) => {
    void lookup(sessionID).then((session) => {
      if (disposed.value) return

      if (!session) return

      if (session.parentID) return

      const hasOpenTab = sessionIDHasOpenTab(tabs.store, input.key, sessionID)

      if (hasOpenTab && settings.sounds.agentEnabled()) {
        void input.coordinator.sound(`${input.key}\0${eventID}`, () => playSoundById(settings.sounds.agent()))
      }

      if (hasOpenTab && settings.notifications.agent()) {
        void input.coordinator.system(`${input.key}\0${eventID}`, () =>
          platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, () =>
            openNotificationSession(tabs, input.key, sessionID),
          ),
        )
      }
    })
  }

  const handleSessionError = (sessionID: string, error: SessionError.Error, eventID: string) => {
    void lookup(sessionID).then((session) => {
      if (disposed.value) return

      if (session?.parentID) return

      const hasOpenTab = sessionIDHasOpenTab(tabs.store, input.key, sessionID)

      if (hasOpenTab && settings.sounds.errorsEnabled()) {
        void input.coordinator.sound(`${input.key}\0${eventID}`, () => playSoundById(settings.sounds.errors()))
      }

      const description =
        session?.title ??
        (typeof error === "string" ? error : language.t("notification.session.error.fallbackDescription"))

      if (hasOpenTab && settings.notifications.errors()) {
        void input.coordinator.system(`${input.key}\0${eventID}`, () =>
          platform.notify(language.t("notification.session.error.title"), description, () =>
            openNotificationSession(tabs, input.key, sessionID),
          ),
        )
      }
    })
  }

  const unsub = input.sdk.event.listen((event) => {
    if (event.type === "session.execution.failed") {
      handleSessionError(event.data.sessionID, event.data.error, event.id)

      return
    }

    if (event.type === "session.execution.succeeded") handleSessionIdle(event.data.sessionID, event.id)
  })

  onCleanup(() => {
    disposed.value = true
    unsub()
  })

  return {
    session: {
      /** Whether the session's root has an execution result no client has viewed yet. */
      unread(sessionID: string) {
        return isSessionUnread(input.data.session.get(input.data.session.root(sessionID)))
      },
      /** Reports the session's latest idle transition to the server as viewed. */
      markViewed: view,
    },
    project: {
      hasUnread(directory: string) {
        return unreadRoots(directory).length > 0
      },
      markViewed(directory: string) {
        unreadRoots(directory).forEach((session) => view(session.id))
      },
    },
  }
}

export const useNotification = () => {
  const server = useServer()

  return server.ctx.notification
}
