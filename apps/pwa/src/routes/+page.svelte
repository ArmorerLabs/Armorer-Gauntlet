<script lang="ts">
  import { goto } from "$app/navigation";
  import { env } from "$env/dynamic/public";
  import { Bell, Plus, RefreshCw, Settings, X } from "lucide-svelte";
  import { onDestroy, onMount, tick } from "svelte";
  import jsQR from "jsqr";
  import {
    compactPath,
    displayTitle,
    isCompleted,
    needsAttention,
    relativeTime,
    statusLabel,
    workspaceName
  } from "$lib/display";
  import { remoteClient, remoteState } from "$lib/remote";
  import type { SessionSummary } from "@armorer/gauntlet-shared";

  type Filter = "all" | "active" | "completed";
  let pairingPayload = "";
  const configuredVapidPublicKey = (env.PUBLIC_VAPID_PUBLIC_KEY ?? "").trim();
  let vapidPublicKey = configuredVapidPublicKey;
  let showPushKeyInput = !configuredVapidPublicKey;
  let pushMessage = "";
  let notificationPermission = "unsupported";
  let notificationPromptDismissed = false;
  let promptsReady = false;
  let showPasteFallback = false;
  let scannerOpen = false;
  let scannerError = "";
  let scanning = false;
  let activeFilter: Filter = "all";
  let searchQuery = "";
  let showNewSession = false;
  let showSettings = false;
  let selectedCwd = "";
  let manualCwd = "";
  let initialMessage = "";
  let creatingSession = false;
  let createError = "";
  let videoEl: HTMLVideoElement;
  let canvasEl: HTMLCanvasElement;
  let cameraStream: MediaStream | undefined;
  let animationFrame: number | undefined;

  $: state = $remoteState;
  $: activeSessions = state.sessions.filter((session) => !isCompleted(session.status));
  $: completedSessions = state.sessions.filter((session) => isCompleted(session.status));
  $: filteredSessions = filterSessions(state.sessions, activeFilter, searchQuery);
  $: workspaceOptions = recentWorkspaces(state.sessions);
  $: chosenCwd = (manualCwd.trim() || selectedCwd.trim()).trim();
  $: pushKey = (showPushKeyInput ? vapidPublicKey : configuredVapidPublicKey).trim();
  $: showNotificationPrompt =
    promptsReady &&
    Boolean(state.peer) &&
    state.sessions.length > 0 &&
    Boolean(pushKey) &&
    notificationPermission === "default" &&
    !notificationPromptDismissed &&
    !showNewSession &&
    !showSettings &&
    !scannerOpen;

  async function pair() {
    await remoteClient.pair(pairingPayload);
  }

  async function pairScanned(payload: string) {
    pairingPayload = payload;
    await remoteClient.pair(payload);
  }

  async function openScanner() {
    scannerError = "";
    scannerOpen = true;
    await tick();
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" }
        }
      });
      videoEl.srcObject = cameraStream;
      await videoEl.play();
      scanning = true;
      scanFrame();
    } catch (error) {
      scannerError = error instanceof Error ? error.message : "Camera access failed";
      closeScanner();
      showPasteFallback = true;
    }
  }

  function scanFrame() {
    if (!scanning) return;
    const width = videoEl?.videoWidth ?? 0;
    const height = videoEl?.videoHeight ?? 0;
    const ready = videoEl?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && canvasEl && width && height;
    if (!ready) {
      animationFrame = requestAnimationFrame(scanFrame);
      return;
    }
    canvasEl.width = width;
    canvasEl.height = height;
    const context = canvasEl.getContext("2d", { willReadFrequently: true });
    context?.drawImage(videoEl, 0, 0, width, height);
    const image = context?.getImageData(0, 0, width, height);
    const code = image && jsQR(image.data, image.width, image.height);
    if (code?.data) {
      closeScanner();
      void pairScanned(code.data);
      return;
    }
    animationFrame = requestAnimationFrame(scanFrame);
  }

  function closeScanner() {
    scannerOpen = false;
    scanning = false;
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = undefined;
    if (videoEl) videoEl.srcObject = null;
  }

  async function refresh() {
    await remoteClient.requestSessions();
  }

  function openNewSession() {
    selectedCwd = workspaceOptions[0] ?? "";
    manualCwd = "";
    initialMessage = "";
    createError = "";
    showNewSession = true;
  }

  async function createSession() {
    if (!chosenCwd || creatingSession) return;
    creatingSession = true;
    createError = "";
    try {
      const session = await remoteClient.createSession(chosenCwd, initialMessage);
      showNewSession = false;
      await goto(`/sessions/${session.id}`);
    } catch (error) {
      createError = error instanceof Error ? error.message : "Could not create session";
    } finally {
      creatingSession = false;
    }
  }

  async function enablePush() {
    pushMessage = "";
    try {
      await remoteClient.enablePush(pushKey);
      pushMessage = "Push enabled for this device.";
      if (!configuredVapidPublicKey) vapidPublicKey = "";
    } catch (error) {
      pushMessage = error instanceof Error ? error.message : "Push setup failed";
    } finally {
      refreshNotificationPermission();
    }
  }

  async function testPush() {
    pushMessage = "";
    try {
      await remoteClient.testPush();
      pushMessage = "Test notification sent.";
    } catch (error) {
      pushMessage = error instanceof Error ? error.message : "Test notification failed";
    }
  }

  function filterSessions(sessions: SessionSummary[], filter: Filter, query: string): SessionSummary[] {
    const needle = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (filter === "active" && isCompleted(session.status)) return false;
      if (filter === "completed" && !isCompleted(session.status)) return false;
      if (!needle) return true;
      return [displayTitle(session), session.preview, session.cwd, session.status]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }

  function recentWorkspaces(sessions: SessionSummary[]): string[] {
    const seen = new Set<string>();
    const workspaces: string[] = [];
    for (const session of sessions) {
      const cwd = session.cwd.trim();
      if (!cwd || seen.has(cwd)) continue;
      seen.add(cwd);
      workspaces.push(cwd);
      if (workspaces.length >= 8) break;
    }
    return workspaces;
  }

  function refreshNotificationPermission() {
    notificationPermission =
      "Notification" in window && "PushManager" in window && "serviceWorker" in navigator
        ? Notification.permission
        : "unsupported";
  }

  onMount(() => {
    refreshNotificationPermission();
    const promptTimer = window.setTimeout(() => {
      promptsReady = true;
    }, 700);
    return () => {
      window.clearTimeout(promptTimer);
    };
  });
  onDestroy(closeScanner);
</script>

<svelte:head>
  <title>Armorer Gauntlet</title>
</svelte:head>

<main class="app-shell">
  <header class="app-header">
    <div class="brand-compact">
      <span class="gauntlet-mark small" aria-hidden="true"></span>
      <div>
        <strong>Armorer</strong>
        <span>{state.peer?.daemonName ?? "Not paired"} · {state.connected ? "Connected" : "Offline"}</span>
      </div>
    </div>
    {#if state.peer}
      <div class="header-actions">
        <button class="icon-button bordered" aria-label="Refresh sessions" title="Refresh sessions" on:click={refresh}>
          <RefreshCw size={21} strokeWidth={2.4} aria-hidden="true" />
        </button>
        <button class="icon-button bordered" aria-label="New session" title="New session" on:click={openNewSession}>
          <Plus size={23} strokeWidth={2.6} aria-hidden="true" />
        </button>
        <button class="icon-button bordered" aria-label="Settings" title="Settings" on:click={() => (showSettings = true)}>
          <Settings size={21} strokeWidth={2.4} aria-hidden="true" />
        </button>
      </div>
    {:else}
      <div class="connection-dot" class:online={state.connected}></div>
    {/if}
  </header>

  {#if state.error}
    <div class="notice error">{state.error}</div>
  {/if}

  {#if !state.peer}
    <section class="pair-panel">
      <div>
        <h1>Pair your phone</h1>
        <p>Scan the QR printed by `make start`. The phone opens the app and claims a one-time pairing token.</p>
      </div>
      {#if scannerOpen}
        <div class="scanner-frame">
          <video bind:this={videoEl} playsinline muted aria-label="Pairing QR scanner"></video>
          <span>Scanning...</span>
        </div>
        <canvas bind:this={canvasEl} class="scanner-canvas" aria-hidden="true"></canvas>
        <button class="secondary-action" on:click={closeScanner}>Stop camera</button>
      {:else}
        <button class="primary-action" disabled={state.pairing} on:click={openScanner}>
          {state.pairing ? "Pairing..." : "Scan QR code"}
        </button>
      {/if}

      {#if scannerError}
        <p class="scanner-error">{scannerError}</p>
      {/if}

      <button class="text-button" on:click={() => (showPasteFallback = !showPasteFallback)}>
        {showPasteFallback ? "Hide paste fallback" : "Paste payload instead"}
      </button>

      {#if showPasteFallback}
        <div class="paste-fallback">
          <textarea bind:value={pairingPayload} spellcheck="false" placeholder="Paste pairing payload"></textarea>
          <button class="secondary-action" disabled={!pairingPayload.trim() || state.pairing} on:click={pair}>
            {state.pairing ? "Pairing..." : "Pair from payload"}
          </button>
        </div>
      {/if}
    </section>
  {:else}
    <section class="inbox-controls">
      <input bind:value={searchQuery} class="search-input" type="search" placeholder="Search sessions or paths" />
      <div class="filter-tabs" aria-label="Session filter">
        <button class:active={activeFilter === "all"} on:click={() => (activeFilter = "all")}>
          All <span>{state.sessions.length}</span>
        </button>
        <button class:active={activeFilter === "active"} on:click={() => (activeFilter = "active")}>
          Active <span>{activeSessions.length}</span>
        </button>
        <button class:active={activeFilter === "completed"} on:click={() => (activeFilter = "completed")}>
          Done <span>{completedSessions.length}</span>
        </button>
      </div>
    </section>

    {#if state.attentions.length}
      <section class="attention-strip">
        {#each state.attentions.slice(0, 2) as attention}
          <a class="attention-card" href={attention.threadId ? `/sessions/${attention.threadId}` : "/"}>
            <strong>{attention.title}</strong>
            <span>{attention.body}</span>
          </a>
        {/each}
      </section>
    {/if}

    {#if showNotificationPrompt}
      <section class="prompt-card notification-card" aria-label="Enable notifications">
        <div>
          <strong>Enable notifications</strong>
          <span>Get alerts when a session needs approval, input, or is ready for the next instruction.</span>
        </div>
        <div>
          <button class="small-button" on:click={enablePush}>
            <Bell size={15} strokeWidth={2.4} aria-hidden="true" />
            Allow
          </button>
          <button class="text-button" on:click={() => (notificationPromptDismissed = true)}>Later</button>
        </div>
      </section>
    {/if}

    <section class="session-list dense-list" aria-label="Sessions">
      {#if !filteredSessions.length}
        <p class="empty">No sessions match this view.</p>
      {/if}
      {#each filteredSessions as session}
        <a class="session-card dense" class:attention={needsAttention(session.status)} href={`/sessions/${session.id}`}>
          <div class="session-main">
            <div class="session-title-row">
              <strong>{displayTitle(session)}</strong>
              {#if needsAttention(session.status)}
                <span class="attention-dot" aria-label="Needs attention"></span>
              {/if}
            </div>
            <span>{workspaceName(session.cwd) || session.source} · {compactPath(session.cwd, 32)}</span>
          </div>
          <span class="status-chip">{statusLabel(session.status)}</span>
          <time>{relativeTime(session.updatedAt)}</time>
        </a>
      {/each}
    </section>
  {/if}
</main>

{#if showNewSession}
  <div class="sheet-backdrop" role="presentation" on:click={() => (showNewSession = false)}></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="New session">
    <header>
      <h2>New session</h2>
      <button class="icon-button" aria-label="Close" title="Close" on:click={() => (showNewSession = false)}>
        <X size={23} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </header>
    {#if workspaceOptions.length}
      <div class="workspace-list" aria-label="Recent workspaces">
        {#each workspaceOptions as cwd}
          <button class:active={selectedCwd === cwd && !manualCwd.trim()} on:click={() => ((selectedCwd = cwd), (manualCwd = ""))}>
            <strong>{workspaceName(cwd)}</strong>
            <span>{compactPath(cwd, 42)}</span>
          </button>
        {/each}
      </div>
    {/if}
    <label class="field-stack">
      <span>Manual path</span>
      <input bind:value={manualCwd} placeholder="/Users/you/project" />
    </label>
    <label class="field-stack">
      <span>First message</span>
      <textarea bind:value={initialMessage} rows="4" placeholder="Ask Codex to start work..."></textarea>
    </label>
    {#if createError}
      <p class="inline-error">{createError}</p>
    {/if}
    <button class="primary-action" disabled={!chosenCwd || creatingSession} on:click={createSession}>
      {creatingSession ? "Creating..." : "Create session"}
    </button>
  </div>
{/if}

{#if showSettings}
  <div class="sheet-backdrop" role="presentation" on:click={() => (showSettings = false)}></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Settings">
    <header>
      <h2>Settings</h2>
      <button class="icon-button" aria-label="Close" title="Close" on:click={() => (showSettings = false)}>
        <X size={23} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </header>

    <div class="settings-group">
      <strong>Pairing</strong>
      <dl>
        <div>
          <dt>Daemon</dt>
          <dd>{state.daemon?.name ?? state.peer?.daemonName ?? "Unknown"}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{state.connected ? "Connected" : "Offline"}</dd>
        </div>
        <div>
          <dt>Phones</dt>
          <dd>{state.daemon?.pairedDeviceCount ?? 1} paired</dd>
        </div>
        <div>
          <dt>Paired</dt>
          <dd>{state.peer?.pairedAt ? new Date(state.peer.pairedAt).toLocaleString() : "Unknown"}</dd>
        </div>
      </dl>
      <p>
        QR links use a short-lived one-time token. If someone scans first, they can pair this device, but that same
        token cannot be reused after it is claimed.
      </p>
      <button class="secondary-action danger-outline" on:click={() => remoteClient.clear()}>
        Reset pairing on this phone
      </button>
      <button class="secondary-action danger-outline" on:click={() => remoteClient.revokePairedPhones()}>
        Revoke paired phones on daemon
      </button>
      <p class="muted">Revoking daemon pairings signs every phone out. Run `make start` again to print a fresh QR.</p>
    </div>

    <div class="settings-group">
      <strong>Push notifications</strong>
      <span>{configuredVapidPublicKey ? "Relay push is configured." : "Paste the relay public key to enable alerts."}</span>
      {#if showPushKeyInput}
        <input bind:value={vapidPublicKey} placeholder="VAPID public key" />
      {/if}
      <div class="push-actions">
        <button class="small-button" disabled={!pushKey} on:click={enablePush}>Enable push</button>
        <button class="small-button" on:click={testPush}>Send test</button>
        {#if configuredVapidPublicKey}
          <button class="text-button" on:click={() => (showPushKeyInput = !showPushKeyInput)}>
            {showPushKeyInput ? "Use configured key" : "Use another key"}
          </button>
        {/if}
      </div>
      {#if pushMessage}
        <p>{pushMessage}</p>
      {/if}
    </div>
  </div>
{/if}
