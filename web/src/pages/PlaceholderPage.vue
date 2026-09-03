<script setup lang="ts">
import { Hammer } from "lucide-vue-next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

defineProps<{ title: string }>();
</script>

<template>
  <div class="flex h-full items-center justify-center p-8">
    <Card class="w-full max-w-md">
      <CardHeader>
        <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <Hammer class="h-5 w-5 text-muted-foreground" />
        </div>
        <CardTitle>{{ title }}</CardTitle>
        <CardDescription>Coming in Phase 3</CardDescription>
      </CardHeader>
      <CardContent>
        <p class="text-sm text-muted-foreground">
          This section hasn't been migrated to the new Vue admin yet. The legacy
          HTMX admin is still available on the backend port in the meantime.
        </p>
      </CardContent>
    </Card>
  </div>
</template>
