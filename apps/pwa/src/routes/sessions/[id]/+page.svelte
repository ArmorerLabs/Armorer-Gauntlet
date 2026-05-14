<script lang="ts">
  import { browser } from "$app/environment";
  import { tick } from "svelte";
  import { page } from "$app/stores";
  import { ArrowDown, ArrowLeft, ArrowUp, RefreshCw } from "lucide-svelte";
  import { unwrapNestedErrorMessage } from "@armorer/gauntlet-shared";
  import { compactPath, displaySubtitle, displayTitle, relativeTime, statusLabel } from "$lib/display";
  import { renderMarkdown } from "$lib/markdown";
  import { remoteClient, remoteState } from "$lib/remote";

  const ITEM_LABELS: Record<string, string> = {
    userMessage: "You",
    agentMessage: "Codex",
    commandExecution: "Command",
    reasoning: "Reasoning",
    fileChange: "Files",
    plan: "Plan"
  };

  let draft = "";
  let sendError = "";
  let appliedScrollSignature = "";
  let requestedThreadId = "";
  $: threadId = $page.params.id;
  $: state = $remoteState;
  $: thread = state.threads[threadId];
  $: pendingTurn = state.pendingTurns[threadId];
  $: sending = pendingTurn?.status === "sending" || pendingTurn?.status === "accepted" || pendingTurn?.status === "running";
  $: pending = state.attentions.filter(
    (item) => item.pendingApproval && (item.threadId === threadId || !item.threadId)
  );
  $: latestTurn = thread?.turns.at(-1);
  $: latestItem = latestTurn?.items.at(-1);
  $: preparingSession = Boolean(thread && !thread.turns.length && ["active", "running", "starting"].some((status) => thread.status.includes(status)));
  $: bottomContentSignature = thread
    ? [
        thread.id,
        thread.turns.length,
        latestTurn?.id ?? "",
        latestTurn?.items.length ?? 0,
        latestItem?.id ?? "",
        pending.map((item) => `${item.id}:${item.pendingApproval?.codexRequestId ?? ""}`).join(","),
        pendingTurn?.status ?? "",
        preparingSession ? "preparing" : ""
      ].join("|")
    : "";
  $: friendlyError =
    state.error?.includes("no rollout found for thread id") ||
    state.error?.includes("is not materialized yet") ||
    state.error?.includes("includeTurns is unavailable before first user message") ||
    /rollout (?:at )?.*\.jsonl is empty/i.test(state.error ?? "") ||
    /failed to read thread.*rollout (?:at )?.*is empty/i.test(state.error ?? "")
    ? "Codex is still preparing this session. Refresh in a moment."
    : state.error;
  $: if (state.ready && state.peer && threadId && requestedThreadId !== threadId) {
    requestedThreadId = threadId;
    appliedScrollSignature = "";
    void remoteClient.readThread(threadId);
  }
  $: if (bottomContentSignature && appliedScrollSignature !== bottomContentSignature) {
    const sameThread = appliedScrollSignature.startsWith(`${threadId}|`);
    appliedScrollSignature = bottomContentSignature;
    void scrollLatest(sameThread ? "smooth" : "auto");
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    draft = "";
    sendError = "";
    try {
      await remoteClient.sendTurn(threadId, text);
      await scrollLatest("smooth");
    } catch (error) {
      sendError = error instanceof Error ? error.message : "Message failed to send";
      draft = draft.trim() ? `${text}\n\n${draft}` : text;
    }
  }

  async function scrollLatest(behavior: ScrollBehavior = "smooth") {
    if (!browser) return;
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const maxScroll = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    window.scrollTo({ top: maxScroll, behavior });
  }

  function labelFor(type: string): string {
    return ITEM_LABELS[type] ?? type;
  }

  function readableOutput(output: string | null | undefined): string {
    const value = output?.trim() ?? "";
    return value ? unwrapNestedErrorMessage(value) : "";
  }

  function rendersMarkdown(type: string): boolean {
    return type === "agentMessage" || type === "plan" || type === "reasoning";
  }
</script>

<svelte:head>
  <title>{displayTitle(thread)} · Armorer Gauntlet</title>
</svelte:head>

<main class="app-shell session-shell">
  <header class="threadbar">
    <a class="back-button" href="/" aria-label="Back" title="Back">
      <ArrowLeft size={29} strokeWidth={2.4} aria-hidden="true" />
    </a>
    <div>
      <strong>{displayTitle(thread)}</strong>
      <span>{displaySubtitle(thread) || "Armorer Gauntlet"}</span>
    </div>
    <button class="icon-button bordered" aria-label="Refresh thread" title="Refresh thread" on:click={() => remoteClient.readThread(threadId)}>
      <RefreshCw size={21} strokeWidth={2.4} aria-hidden="true" />
    </button>
  </header>

  {#if friendlyError}
    <div class="notice error">{friendlyError}</div>
  {/if}

  <section class="thread-content">
    {#if !thread}
      <div class="session-placeholder">
        <span></span>
        <strong>Loading session...</strong>
      </div>
    {:else}
      <div class="command-strip">
        <span>{statusLabel(thread.status)}</span>
        <code>{compactPath(thread.resumeCommand, 64)}</code>
        <time>{relativeTime(thread.updatedAt)}</time>
      </div>

      {#if !thread.turns.length}
        {#if preparingSession}
          <div class="session-placeholder">
            <span></span>
            <strong>Preparing session...</strong>
          </div>
        {:else}
          <p class="empty">Send the first message to start this session.</p>
        {/if}
      {/if}

      {#each thread.turns as turn}
        {#each turn.items as item}
          <article class:item-user={item.type === "userMessage"} class:item-agent={item.type !== "userMessage"} class="thread-item">
            <span>{labelFor(item.type)}</span>
            {#if item.text}
              {#if rendersMarkdown(item.type)}
                <div class="markdown-body">{@html renderMarkdown(item.text)}</div>
              {:else}
                <p>{item.text}</p>
              {/if}
            {/if}
            {#if item.command}
              <pre>{item.command}</pre>
            {/if}
            {#if item.output}
              <pre>{readableOutput(item.output)}</pre>
            {/if}
            {#if item.diff}
              <pre>{item.diff}</pre>
            {/if}
          </article>
        {/each}
      {/each}

      {#if pending.length}
        <section class="approval-stack" aria-label="Pending approvals">
          {#each pending as attention}
            <article class="approval-card">
              <div>
                <strong>{attention.title}</strong>
                <p>{attention.body}</p>
              </div>
              <pre>{attention.pendingApproval?.detail}</pre>
              <div class="approval-actions">
                <button class="small-button danger" on:click={() => remoteClient.respondToApproval(attention, false)}>
                  Decline
                </button>
                <button class="small-button" on:click={() => remoteClient.respondToApproval(attention, true)}>
                  Approve
                </button>
              </div>
            </article>
          {/each}
        </section>
      {/if}

      {#if pendingTurn && pendingTurn.status !== "completed"}
        <div class="turn-state" class:error={pendingTurn.status === "failed"}>
          <span>{pendingTurn.status === "failed" ? "Failed" : pendingTurn.status}</span>
          {#if pendingTurn.error}
            <strong>{pendingTurn.error}</strong>
          {:else if pendingTurn.status === "sending"}
            <strong>Sending to daemon...</strong>
          {:else if pendingTurn.status === "accepted"}
            <strong>Codex accepted the turn.</strong>
          {:else if pendingTurn.status === "running"}
            <strong>Codex is working.</strong>
          {/if}
        </div>
      {/if}
    {/if}
  </section>

  <form class="composer" on:submit|preventDefault={send}>
    {#if sendError}
      <p class="inline-error">{sendError}</p>
    {/if}
    <textarea bind:value={draft} placeholder="Message Codex..." rows="2"></textarea>
    <div>
      <button type="button" class="icon-button bordered" aria-label="Scroll to latest" title="Scroll to latest" on:click={() => scrollLatest()}>
        <ArrowDown size={24} strokeWidth={2.5} aria-hidden="true" />
      </button>
      <span class="mode-chip">{sending ? statusLabel(pendingTurn?.status) : "Codex"}</span>
      <button class="send-button" disabled={!draft.trim() || sending} aria-label="Send" title="Send">
        <ArrowUp size={27} strokeWidth={2.8} aria-hidden="true" />
      </button>
    </div>
  </form>
</main>
