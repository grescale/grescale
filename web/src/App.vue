<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner";
</script>

<template>
  <RouterView />
  <Toaster position="top-right" rich-colors close-button />
</template>
