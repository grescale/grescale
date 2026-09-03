<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { ChevronDown } from "lucide-vue-next";
import { SelectIcon, SelectTrigger, type SelectTriggerProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<
  SelectTriggerProps & { class?: HTMLAttributes["class"] }
>();

const delegatedProps = reactiveOmit(props, "class");
</script>

<template>
  <SelectTrigger
    v-bind="delegatedProps"
    :class="
      cn(
        'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:truncate [&>span]:text-left',
        props.class,
      )
    "
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDown class="h-4 w-4 shrink-0 opacity-50" />
    </SelectIcon>
  </SelectTrigger>
</template>
