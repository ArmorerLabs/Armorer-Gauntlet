<script lang="ts">
  import { onMount } from "svelte";
  import { remoteClient } from "$lib/remote";
  import "../styles.css";

  onMount(() => {
    void remoteClient.initialize();
  });
</script>

<slot />
