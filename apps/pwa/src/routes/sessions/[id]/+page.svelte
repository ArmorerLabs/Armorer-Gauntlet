<script lang="ts">
  import { browser } from "$app/environment";
  import { onMount, tick } from "svelte";
  import { page } from "$app/stores";
  import { ArrowDown, ArrowLeft, ArrowUp, CircleStop, Paperclip, RefreshCw, X, Zap } from "lucide-svelte";
  import { unwrapNestedErrorMessage, type TurnAttachment, type TurnAttachmentSummary } from "@armorer/gauntlet-shared";
  import { fileToTurnAttachment, formatAttachmentSize } from "$lib/attachments";
  import { agentLabel, agentTone, compactPath, displaySubtitle, displayTitle, relativeTime, statusLabel } from "$lib/display";
  import { renderMarkdown, renderPlainTextWithDirectives } from "$lib/markdown";
  import { remoteClient, remoteState } from "$lib/remote";

  const ITEM_LABELS: Record<string, string> = {
    userMessage: "You",
    hookPrompt: "Hook",
    agentMessage: "Codex",
    plan: "Plan",
    reasoning: "Reasoning",
    commandExecution: "Command",
    fileChange: "Files",
    mcpToolCall: "MCP tool",
    dynamicToolCall: "Tool",
    collabAgentToolCall: "Agent tool",
    webSearch: "Search",
    imageView: "Image",
    imageGeneration: "Image",
    enteredReviewMode: "Review",
    exitedReviewMode: "Review",
    contextCompaction: "Context"
  };

  let draft = "";
  let sendError = "";
  let interruptError = "";
  let interrupting = false;
  let attachmentError = "";
  let attachments: TurnAttachment[] = [];
  let appliedScrollSignature = "";
  let requestedThreadId = "";
  let fileInput: HTMLInputElement;
  $: threadId = $page.params.id;
  $: state = $remoteState;
  $: thread = state.threads[threadId];
  $: threadError = state.threadErrors[threadId];
  $: pendingTurn = state.pendingTurns[threadId];
  $: currentAgent = thread?.agent ?? (threadId.startsWith("pi:") ? "pi" : threadId.startsWith("claude:") ? "claude" : "codex");
  $: isExternalAgentThread = currentAgent === "pi" || currentAgent === "claude";
  $: supportsAttachments = !isExternalAgentThread;
  $: sending = pendingTurn?.status === "sending";
  $: turnInFlight =
    pendingTurn?.status === "sending" ||
    pendingTurn?.status === "queued" ||
    pendingTurn?.status === "accepted" ||
    pendingTurn?.status === "running";
  $: threadActive = Boolean(thread?.status && (thread.status === "active" || thread.status.startsWith("active:") || thread.status === "starting"));
  $: canInterrupt = Boolean((threadActive || turnInFlight) && !interrupting && threadError?.code !== "thread_not_found");
  $: canSubmit = Boolean(
    (draft.trim() || (supportsAttachments && attachments.length)) && !sending && threadError?.code !== "thread_not_found"
  );
  $: canSteer = Boolean(canSubmit && threadActive && !isExternalAgentThread);
  $: if (!supportsAttachments && attachments.length) {
    attachments = [];
    attachmentError = "";
  }
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
    appliedScrollSignature = bottomContentSignature;
    void scrollLatest("auto");
  }

  async function send(mode: "next" | "steer" = "next") {
    const text = draft.trim();
    if ((!text && !attachments.length) || sending) return;
    const outgoingAttachments = supportsAttachments ? attachments : [];
    if (!text && !outgoingAttachments.length) return;
    draft = "";
    attachments = [];
    sendError = "";
    interruptError = "";
    attachmentError = "";
    try {
      await remoteClient.sendTurn(threadId, text, outgoingAttachments, mode);
      await scrollLatest("auto");
    } catch (error) {
      sendError = error instanceof Error ? error.message : "Message failed to send";
      draft = draft.trim() ? `${text}\n\n${draft}` : text;
      attachments = [...outgoingAttachments, ...attachments];
    }
  }

  async function interruptTurn() {
    if (!canInterrupt) return;
    interrupting = true;
    interruptError = "";
    try {
      await remoteClient.interruptTurn(threadId);
      await scrollLatest("auto");
    } catch (error) {
      interruptError = error instanceof Error ? error.message : "Stop request failed";
    } finally {
      interrupting = false;
    }
  }

  function handleComposerKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void send();
  }

  async function attachFiles(event: Event) {
    attachmentError = "";
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = "";
    for (const file of files) {
      if (attachments.length >= 4) {
        attachmentError = "Attach up to 4 files per message.";
        break;
      }
      try {
        attachments = [...attachments, await fileToTurnAttachment(file)];
      } catch (error) {
        attachmentError = error instanceof Error ? error.message : "Could not attach file.";
      }
    }
  }

  function removeAttachment(id: string) {
    attachments = attachments.filter((attachment) => attachment.id !== id);
  }

  async function scrollLatest(behavior: ScrollBehavior = "smooth") {
    if (!browser) return;
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const maxScroll = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    window.scrollTo({ top: maxScroll, behavior });
  }

  function labelFor(type: string): string {
    if (type === "agentMessage") return agentLabel(thread);
    return ITEM_LABELS[type] ?? type;
  }

  function readableOutput(output: string | null | undefined): string {
    const value = output?.trim() ?? "";
    return value ? unwrapNestedErrorMessage(value) : "";
  }

  function rendersMarkdown(type: string): boolean {
    return type === "agentMessage" || type === "plan" || type === "reasoning";
  }

  function rendersPlainRichText(type: string): boolean {
    return type === "userMessage";
  }

  function attachmentLabel(attachment: TurnAttachmentSummary): string {
    return `${attachment.kind === "image" ? "Image" : "File"} · ${formatAttachmentSize(attachment.size)}`;
  }

  onMount(() => {
    if (!browser || !window.visualViewport) return;
    const viewport = window.visualViewport;
    let lastOffset = 0;
    const updateKeyboardOffset = () => {
      const offset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      const rounded = Math.round(offset);
      document.documentElement.style.setProperty("--composer-keyboard-offset", `${rounded}px`);
      if (rounded > lastOffset) void scrollLatest("auto");
      lastOffset = rounded;
    };
    updateKeyboardOffset();
    viewport.addEventListener("resize", updateKeyboardOffset);
    viewport.addEventListener("scroll", updateKeyboardOffset);
    return () => {
      viewport.removeEventListener("resize", updateKeyboardOffset);
      viewport.removeEventListener("scroll", updateKeyboardOffset);
      document.documentElement.style.removeProperty("--composer-keyboard-offset");
    };
  });
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
      <strong><span class:pi={agentTone(thread) === "pi"} class:claude={agentTone(thread) === "claude"} class="agent-badge inline">{agentLabel(thread)}</span>{displayTitle(thread)}</strong>
      <span>{displaySubtitle(thread) || "Armorer Gauntlet"}</span>
    </div>
    <button class="icon-button bordered" aria-label="Refresh thread" title="Refresh thread" on:click={() => remoteClient.readThread(threadId)}>
      <RefreshCw size={21} strokeWidth={2.4} aria-hidden="true" />
    </button>
  </header>

  {#if friendlyError}
    <div class="notice error">{friendlyError}</div>
  {/if}

  {#if threadError?.code === "thread_not_found"}
    <div class="notice error stale-session">
      <strong>This session is no longer available on this daemon.</strong>
      <span>Refresh the inbox or open another session from this phone.</span>
      <div>
        <a class="small-button" href="/">Back to sessions</a>
        <button class="small-button" on:click={() => remoteClient.requestSessions()}>Refresh sessions</button>
      </div>
    </div>
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
              {:else if rendersPlainRichText(item.type)}
                <div class="markdown-body">{@html renderPlainTextWithDirectives(item.text)}</div>
              {:else}
                <p>{item.text}</p>
              {/if}
            {/if}
            {#if item.attachments?.length}
              <div class="attachment-list" aria-label="Message attachments">
                {#each item.attachments as attachment}
                  <span>
                    <strong>{attachment.name}</strong>
                    <small>{attachmentLabel(attachment)}</small>
                  </span>
                {/each}
              </div>
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

      {#if pendingTurn && pendingTurn.status !== "completed" && !(latestItem?.type === "agentMessage" && pendingTurn.status === "running")}
        <div class="turn-state" class:error={pendingTurn.status === "failed"}>
          {#if pendingTurn.status === "failed"}
            <span>Failed</span>
            <strong>{pendingTurn.error ?? `${agentLabel(thread)} could not handle the turn.`}</strong>
          {:else if pendingTurn.status === "queued"}
            <span>queued</span>
            <strong>Queued as the next instruction.</strong>
          {:else if pendingTurn.status === "interrupted"}
            <span>stopped</span>
            <strong>{pendingTurn.error ?? "Stopped."}</strong>
          {:else}
            <span class="thinking-dot" aria-hidden="true"></span>
            <strong>{agentLabel(thread)} is thinking...</strong>
          {/if}
        </div>
      {/if}
    {/if}
  </section>

  <form class="composer" on:submit|preventDefault={() => send()}>
    {#if sendError}
      <p class="inline-error">{sendError}</p>
    {/if}
    {#if interruptError}
      <p class="inline-error">{interruptError}</p>
    {/if}
    {#if attachmentError}
      <p class="inline-error">{attachmentError}</p>
    {/if}
    {#if attachments.length}
      <div class="attachment-tray" aria-label="Selected attachments">
        {#each attachments as attachment}
          <span>
            <strong>{attachment.name}</strong>
            <small>{attachmentLabel(attachment)}</small>
            <button type="button" aria-label={`Remove ${attachment.name}`} on:click={() => removeAttachment(attachment.id)}>
              <X size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </span>
        {/each}
      </div>
    {/if}
    <textarea
      bind:value={draft}
      aria-label={`Message ${agentLabel(thread)}`}
      placeholder={`Message ${agentLabel(thread)}...`}
      rows="2"
      enterkeyhint="send"
      disabled={threadError?.code === "thread_not_found"}
      on:keydown={handleComposerKeydown}
    ></textarea>
    {#if supportsAttachments}
      <input
        bind:this={fileInput}
        class="visually-hidden"
        type="file"
        multiple
        accept="image/*,text/*,.md,.txt,.json,.ts,.tsx,.js,.jsx,.svelte,.css,.html,.xml,.yaml,.yml,.toml,.py,.rs,.go,.sh,.log,.csv"
        on:change={attachFiles}
      />
    {/if}
    <div class="composer-actions">
      {#if supportsAttachments}
        <button type="button" class="icon-button bordered" aria-label="Attach file" title="Attach file" on:click={() => fileInput.click()}>
          <Paperclip size={22} strokeWidth={2.5} aria-hidden="true" />
        </button>
      {/if}
      <button type="button" class="icon-button bordered" aria-label="Scroll to latest" title="Scroll to latest" on:click={() => scrollLatest()}>
        <ArrowDown size={24} strokeWidth={2.5} aria-hidden="true" />
      </button>
      {#if canInterrupt}
        <button type="button" class="icon-button bordered stop-button" aria-label="Stop session" title="Stop session" on:click={interruptTurn}>
          <CircleStop size={22} strokeWidth={2.5} aria-hidden="true" />
        </button>
      {/if}
      <span class="mode-chip">{turnInFlight ? statusLabel(pendingTurn?.status) : agentLabel(thread)}</span>
      {#if canSteer}
        <button type="button" class="icon-button bordered" aria-label="Force steer" title="Force steer" on:click={() => send("steer")}>
          <Zap size={21} strokeWidth={2.5} aria-hidden="true" />
        </button>
      {/if}
      <button class="send-button" disabled={!canSubmit} aria-label="Send" title="Send">
        <ArrowUp size={27} strokeWidth={2.8} aria-hidden="true" />
      </button>
    </div>
  </form>
</main>
