<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { DialogTitle, type DialogTitleProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<
  DialogTitleProps & { class?: HTMLAttributes["class"] }
>();

const delegatedProps = reactiveOmit(props, "class");
</script>

<template>
  <DialogTitle
    v-bind="delegatedProps"
    :class="cn('text-lg font-semibold text-foreground', props.class)"
  >
    <slot />
  </DialogTitle>
</template>
