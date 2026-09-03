<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorView, placeholder as cmPlaceholder, keymap } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: "sql" | "javascript" | "plain";
    placeholder?: string;
    minHeight?: string;
    autofocus?: boolean;
  }>(),
  {
    language: "plain",
    placeholder: "",
    minHeight: "120px",
    autofocus: false,
  },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "run"): void;
}>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
let themeObserver: MutationObserver | null = null;
// Guard so external model updates pushed into the editor don't echo back.
let applyingExternal = false;

const themeCompartment = new Compartment();
const langCompartment = new Compartment();

function langExtension() {
  if (props.language === "sql") return sql();
  if (props.language === "javascript") return javascript();
  return [];
}

function themeExtension() {
  return document.documentElement.classList.contains("dark") ? oneDark : [];
}

onMounted(() => {
  if (!host.value) return;

  view = new EditorView({
    parent: host.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        history(),
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              emit("run");
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        langCompartment.of(langExtension()),
        themeCompartment.of(themeExtension()),
        props.placeholder ? cmPlaceholder(props.placeholder) : [],
        EditorView.theme({
          "&": {
            minHeight: props.minHeight,
            fontSize: "12px",
            borderRadius: "6px",
            border: "1px solid hsl(var(--border))",
            backgroundColor: "hsl(var(--background))",
          },
          ".cm-content": {
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, monospace",
            padding: "8px 0",
          },
          ".cm-scroller": { overflow: "auto" },
          "&.cm-focused": {
            outline: "2px solid hsl(var(--ring))",
            outlineOffset: "-1px",
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingExternal) {
            emit("update:modelValue", update.state.doc.toString());
          }
        }),
      ],
    }),
  });

  if (props.autofocus) view.focus();

  themeObserver = new MutationObserver(() => {
    view?.dispatch({ effects: themeCompartment.reconfigure(themeExtension()) });
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
});

watch(
  () => props.modelValue,
  (value) => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (value === current) return;
    applyingExternal = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
    applyingExternal = false;
  },
);

watch(
  () => props.language,
  () => {
    view?.dispatch({ effects: langCompartment.reconfigure(langExtension()) });
  },
);

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="host" class="code-editor w-full" />
</template>
