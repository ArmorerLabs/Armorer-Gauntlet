/// <reference types="@sveltejs/kit" />
import { DEFAULT_PUSH_PAYLOAD } from "@armorer/gauntlet-shared";

interface ArmorerPushEvent {
  data?: { json: () => unknown };
  waitUntil: (promise: Promise<unknown>) => void;
}

interface ArmorerNotificationClickEvent {
  notification: {
    close: () => void;
    data?: { url?: unknown };
  };
  waitUntil: (promise: Promise<unknown>) => void;
}

interface ArmorerWindowClient {
  url: string;
  focus?: () => Promise<unknown>;
}

type ArmorerNotificationOptions = NotificationOptions & {
  badge?: string;
  data?: unknown;
  renotify?: boolean;
  requireInteraction?: boolean;
};

interface ArmorerServiceWorkerGlobal {
  location: Location;
  registration: {
    showNotification: (title: string, options: ArmorerNotificationOptions) => Promise<void>;
  };
  clients: {
    matchAll: (options: { type: "window"; includeUncontrolled: boolean }) => Promise<ArmorerWindowClient[]>;
    openWindow: (url: string) => Promise<unknown>;
  };
  addEventListener: {
    (type: "push", listener: (event: ArmorerPushEvent) => void): void;
    (type: "notificationclick", listener: (event: ArmorerNotificationClickEvent) => void): void;
  };
}

const worker = self as unknown as ArmorerServiceWorkerGlobal;

worker.addEventListener("push", (event) => {
  const data = event.data?.json() as { title?: string; body?: string; tag?: string } | undefined;
  event.waitUntil(
    worker.registration.showNotification(data?.title ?? DEFAULT_PUSH_PAYLOAD.title, {
      body: data?.body ?? DEFAULT_PUSH_PAYLOAD.body,
      tag: data?.tag ?? DEFAULT_PUSH_PAYLOAD.tag,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: {
        url: "/"
      },
      renotify: true,
      requireInteraction: true
    })
  );
});

worker.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
  event.waitUntil(focusOrOpen(url));
});

async function focusOrOpen(url: string): Promise<void> {
  const clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
  const sameOriginClients = clients.filter((client) => new URL(client.url).origin === worker.location.origin);
  const focused = sameOriginClients.find((client) => client.focus);
  if (focused?.focus) {
    await focused.focus();
    return;
  }
  await worker.clients.openWindow(url);
}
