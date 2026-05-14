import { DEFAULT_PUSH_PAYLOAD } from "@armorer/gauntlet-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

type ServiceWorkerListener = (event: {
  data?: { json: () => unknown };
  notification?: { close: () => void; data?: unknown };
  waitUntil: (promise: Promise<unknown>) => void;
}) => void;

interface LoadedServiceWorker {
  listeners: Map<string, ServiceWorkerListener>;
  showNotification: ReturnType<typeof vi.fn>;
  matchAll: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("service worker notifications", () => {
  it("shows the generic Armorer notification for push events", async () => {
    const worker = await loadServiceWorker();
    const waitUntil = captureWaitUntil();

    worker.listeners.get("push")?.({
      data: { json: () => ({}) },
      waitUntil
    });
    await waitUntil.done();

    expect(worker.showNotification).toHaveBeenCalledWith(DEFAULT_PUSH_PAYLOAD.title, {
      body: DEFAULT_PUSH_PAYLOAD.body,
      tag: DEFAULT_PUSH_PAYLOAD.tag,
      icon: "/icon.svg",
      badge: "/icon.svg",
      data: { url: "/" },
      renotify: true,
      requireInteraction: true
    });
  });

  it("focuses an existing app window when a notification is clicked", async () => {
    const worker = await loadServiceWorker();
    const waitUntil = captureWaitUntil();
    const close = vi.fn();
    const focus = vi.fn().mockResolvedValue(undefined);
    worker.matchAll.mockResolvedValue([{ url: "https://gauntlet.test/sessions/t1", focus }]);

    worker.listeners.get("notificationclick")?.({
      notification: { close, data: { url: "/sessions/t1" } },
      waitUntil
    });
    await waitUntil.done();

    expect(close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it("opens the app when no existing window can be focused", async () => {
    const worker = await loadServiceWorker();
    const waitUntil = captureWaitUntil();
    worker.matchAll.mockResolvedValue([]);

    worker.listeners.get("notificationclick")?.({
      notification: { close: vi.fn(), data: { url: "/sessions/t1" } },
      waitUntil
    });
    await waitUntil.done();

    expect(worker.openWindow).toHaveBeenCalledWith("/sessions/t1");
  });
});

async function loadServiceWorker(): Promise<LoadedServiceWorker> {
  vi.resetModules();
  const listeners = new Map<string, ServiceWorkerListener>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const matchAll = vi.fn().mockResolvedValue([]);
  const openWindow = vi.fn().mockResolvedValue(undefined);

  vi.stubGlobal("self", {
    location: { origin: "https://gauntlet.test" },
    registration: { showNotification },
    clients: { matchAll, openWindow },
    addEventListener: vi.fn((type: string, listener: ServiceWorkerListener) => {
      listeners.set(type, listener);
    })
  });

  await import("./service-worker");
  return { listeners, showNotification, matchAll, openWindow };
}

function captureWaitUntil() {
  const promises: Promise<unknown>[] = [];
  const waitUntil = (promise: Promise<unknown>) => {
    promises.push(promise);
  };
  waitUntil.done = async () => {
    await Promise.all(promises);
  };
  return waitUntil;
}
