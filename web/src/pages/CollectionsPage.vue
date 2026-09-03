<script setup lang="ts">
import { watch } from "vue";
import { useRouter } from "vue-router";
import { Database } from "lucide-vue-next";
import { useCollectionsStore } from "@/stores/collections";

const router = useRouter();
const store = useCollectionsStore();

store.fetchAll();

watch(
  () => [store.loaded, store.collections.length] as const,
  ([loaded, count]) => {
    if (loaded && count > 0 && !store.currentName) {
      router.replace(`/collections/${store.collections[0].name}`);
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex h-full flex-col items-center justify-center gap-3 p-8">
    <Database class="h-10 w-10 text-muted-foreground/50" />
    <h1 class="text-xl font-semibold tracking-tight">No collection selected</h1>
    <p class="max-w-sm text-center text-sm text-muted-foreground">
      Pick a collection from the panel on the left, or create a new one with the
      + button.
    </p>
  </div>
</template>
