/// <reference types="@sveltejs/kit" />
import { DEFAULT_PUSH_PAYLOAD } from "@armorer/gauntlet-shared";

self.addEventListener("push", (event) => {
  const data = event.data?.json() as { title?: string; body?: string; tag?: string } | undefined;
  event.waitUntil(
    self.registration.showNotification(data?.title ?? DEFAULT_PUSH_PAYLOAD.title, {
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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/";
  event.waitUntil(focusOrOpen(url));
});

async function focusOrOpen(url: string): Promise<void> {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const sameOriginClients = clients.filter((client) => new URL(client.url).origin === self.location.origin);
  const focused = sameOriginClients.find((client) => "focus" in client);
  if (focused && "focus" in focused) {
    await focused.focus();
    return;
  }
  await self.clients.openWindow(url);
}
