<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Loader2, Plus, X } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { api, ApiError } from "@/lib/api";
import { useCollectionsStore, type CollectionMeta } from "@/stores/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import CodeEditor from "@/components/CodeEditor.vue";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const props = defineProps<{ collectionName: string | null }>();
const emit = defineEmits<{
  (e: "update:collection-name", value: string | null): void;
}>();

const router = useRouter();
const store = useCollectionsStore();

const open = computed({
  get: () => props.collectionName !== null,
  set: (v: boolean) => {
    if (!v) emit("update:collection-name", null);
  },
});

const FIELD_TYPES = [
  "text",
  "number",
  "boolean",
  "email",
  "url",
  "date",
  "date_only",
  "richtext",
  "json",
  "file",
  "relation",
];

const DATE_FORMATS = ["DD-MM-YYYY", "DD/MM/YYYY", "YYYY-MM-DD", "YYYY/MM/DD"];

interface FieldRow {
  name: string;
  originalName?: string;
  isNew: boolean;
  system: boolean;
  type: string;
  required: boolean;
  regex: string;
  trim_input: boolean;
  min: string;
  max: string;
  nonzero: boolean;
  date_format: string;
  relation_collection: string;
}

interface IndexRow {
  fields: string;
  type: "index" | "unique";
}

const collection = ref<CollectionMeta | null>(null);
const name = ref("");
const viewQuery = ref("");
const authMethod = ref<"email" | "username" | "both">("email");
const googleEnabled = ref(false);
const fields = reactive<FieldRow[]>([]);
const indexes = reactive<IndexRow[]>([]);
const rules = reactive({
  list_rule: "",
  view_rule: "",
  create_rule: "",
  update_rule: "",
  delete_rule: "",
});
// A rule stored as "" means public; null means admin-only. These flags keep
// that distinction, which the empty editor alone cannot express.
const publicRules = reactive({
  list_rule: false,
  view_rule: false,
  create_rule: false,
  update_rule: false,
  delete_rule: false,
});
const saving = ref(false);
const deleting = ref(false);
const deleteConfirmOpen = ref(false);

const isView = computed(() => collection.value?.type === "view");
const isAuth = computed(() => collection.value?.type === "auth");

function toFieldRow(f: CollectionMeta["schema"][number]): FieldRow {
  return {
    name: f.name,
    originalName: f.name,
    isNew: false,
    system: f.system === true,
    type: f.type || "text",
    required: f.required === true,
    regex: f.regex ?? "",
    trim_input: f.trim_input === true,
    min: f.min !== undefined && f.min !== null ? String(f.min) : "",
    max: f.max !== undefined && f.max !== null ? String(f.max) : "",
    nonzero: f.nonzero === true,
    date_format: f.date_format || "YYYY-MM-DD",
    relation_collection: f.relation_collection ?? "",
  };
}

function newFieldRow(): FieldRow {
  return {
    name: "",
    isNew: true,
    system: false,
    type: "text",
    required: false,
    regex: "",
    trim_input: false,
    min: "",
    max: "",
    nonzero: false,
    date_format: "YYYY-MM-DD",
    relation_collection: "",
  };
}

watch(
  () => props.collectionName,
  async (collectionName) => {
    if (!collectionName) return;
    collection.value = null;
    fields.splice(0, fields.length);
    indexes.splice(0, indexes.length);
    try {
      const data = await api.get<{ collection: CollectionMeta }>(
        `/internal/api/admin/collections/${encodeURIComponent(collectionName)}`,
      );
      const col = data.collection;
      collection.value = col;
      name.value = col.name;
      viewQuery.value = col.view_query ?? "";
      authMethod.value =
        (col.oauth2?.auth_method as "email" | "username" | "both") || "email";
      googleEnabled.value = col.oauth2?.google_enabled === true;
      fields.splice(
        0,
        fields.length,
        ...(col.schema || []).map(toFieldRow),
      );
      rules.list_rule = col.list_rule ?? "";
      rules.view_rule = col.view_rule ?? "";
      rules.create_rule = col.create_rule ?? "";
      rules.update_rule = col.update_rule ?? "";
      rules.delete_rule = col.delete_rule ?? "";
      publicRules.list_rule = col.list_rule === "";
      publicRules.view_rule = col.view_rule === "";
      publicRules.create_rule = col.create_rule === "";
      publicRules.update_rule = col.update_rule === "";
      publicRules.delete_rule = col.delete_rule === "";
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Failed to load collection settings.",
      );
      emit("update:collection-name", null);
    }
  },
);

function addField() {
  fields.push(newFieldRow());
}

function removeField(idx: number) {
  fields.splice(idx, 1);
}

function addIndex() {
  indexes.push({ fields: "", type: "index" });
}

function removeIndex(idx: number) {
  indexes.splice(idx, 1);
}

async function onSubmit() {
  if (!props.collectionName || !collection.value) return;

  const ruleValue = (key: keyof typeof rules) =>
    publicRules[key] ? "" : rules[key].trim() ? rules[key] : null;

  const payload: Record<string, unknown> = {
    name: name.value,
    list_rule: ruleValue("list_rule"),
    view_rule: ruleValue("view_rule"),
    create_rule: ruleValue("create_rule"),
    update_rule: ruleValue("update_rule"),
    delete_rule: ruleValue("delete_rule"),
  };

  if (isView.value) {
    payload.view_query = viewQuery.value;
  } else {
    payload.schema = fields
      .filter((f) => f.system || f.name.trim())
      .map((f) => {
        const out: Record<string, unknown> = {
          name: f.name,
          type: f.type,
          required: f.required,
        };
        if (f.system) out.system = true;
        else out.originalName = f.originalName ?? f.name;
        if (f.isNew) out.isNew = true;
        if (f.type === "text") {
          if (f.regex.trim()) out.regex = f.regex.trim();
          out.trim_input = f.trim_input;
        }
        if (f.type === "number") {
          if (f.min !== "") out.min = Number(f.min);
          if (f.max !== "") out.max = Number(f.max);
          out.nonzero = f.nonzero;
        }
        if (f.type === "date_only") out.date_format = f.date_format;
        if (f.type === "relation" && f.relation_collection.trim()) {
          out.relation_collection = f.relation_collection.trim();
        }
        return out;
      });
    payload.indexes = indexes
      .filter((i) => i.fields.trim())
      .map((i) => ({ fields: i.fields, type: i.type }));
  }

  if (isAuth.value) {
    payload.auth_method = authMethod.value;
    payload.google_enabled = googleEnabled.value;
  }

  saving.value = true;
  try {
    const data = await api.post<{ collection: CollectionMeta }>(
      `/internal/api/admin/collections/${encodeURIComponent(props.collectionName)}/settings`,
      payload,
    );
    toast.success("Collection settings saved.");
    const newName = data.collection.name;
    emit("update:collection-name", null);
    await store.refresh();
    if (newName !== props.collectionName) {
      router.push(`/collections/${newName}`);
    }
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Failed to save settings.",
    );
  } finally {
    saving.value = false;
  }
}

async function onDeleteCollection() {
  if (!props.collectionName) return;
  deleting.value = true;
  try {
    await api.delete(
      `/internal/api/admin/collections/${encodeURIComponent(props.collectionName)}`,
    );
    toast.success("Collection deleted.");
    deleteConfirmOpen.value = false;
    emit("update:collection-name", null);
    await store.refresh();
    router.push("/collections");
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Failed to delete collection.",
    );
  } finally {
    deleting.value = false;
  }
}

const ruleFields: { key: keyof typeof rules; label: string }[] = [
  { key: "list_rule", label: "List rule" },
  { key: "view_rule", label: "View rule" },
  { key: "create_rule", label: "Create rule" },
  { key: "update_rule", label: "Update rule" },
  { key: "delete_rule", label: "Delete rule" },
];
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent class="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
      <SheetHeader class="border-b px-6 py-4">
        <SheetTitle>Collection Settings</SheetTitle>
        <SheetDescription>
          Edit fields, rules and options for
          <span class="font-mono">{{ collectionName }}</span
          >.
        </SheetDescription>
      </SheetHeader>

      <div v-if="!collection" class="flex-1 p-6 text-sm text-muted-foreground">
        Loading…
      </div>

      <form
        v-else
        class="flex min-h-0 flex-1 flex-col"
        @submit.prevent="onSubmit"
      >
        <div class="flex-1 space-y-6 overflow-y-auto p-6">
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <Label for="cs-name">Collection Name</Label>
              <Input
                id="cs-name"
                v-model="name"
                required
                title="Only alphanumeric characters and underscores allowed. Spaces will be converted."
              />
            </div>
            <div class="space-y-1.5">
              <Label>Type</Label>
              <Input
                :model-value="collection.type.toUpperCase()"
                disabled
                class="font-mono text-muted-foreground"
              />
            </div>
          </div>

          <Tabs default-value="fields">
            <TabsList>
              <TabsTrigger value="fields">Fields</TabsTrigger>
              <TabsTrigger value="rules">Rules &amp; Options</TabsTrigger>
            </TabsList>

            <TabsContent value="fields" class="space-y-6 pt-2">
              <template v-if="isView">
                <div class="space-y-1.5">
                  <Label for="cs-view-query">SQL query</Label>
                  <Textarea
                    id="cs-view-query"
                    v-model="viewQuery"
                    rows="6"
                    class="font-mono text-xs"
                  />
                  <p class="text-xs text-muted-foreground">
                    The view is re-created from this SELECT query on save.
                  </p>
                </div>
              </template>

              <template v-else>
                <div class="space-y-3">
                  <h3 class="text-sm font-semibold">Fields</h3>
                  <p class="text-xs text-muted-foreground">
                    Adding, renaming, or deleting fields will modify the
                    underlying Postgres table automatically. System fields
                    cannot be changed.
                  </p>

                  <div
                    v-for="(field, idx) in fields"
                    :key="field.originalName ?? `new-${idx}`"
                    class="space-y-3 rounded-md border p-3"
                    :class="field.system ? 'opacity-80' : ''"
                  >
                    <div class="flex items-end gap-3">
                      <div class="flex-1 space-y-1">
                        <Label class="text-xs">Name</Label>
                        <Input
                          v-model="field.name"
                          :disabled="field.system"
                          placeholder="field_name"
                          class="h-8"
                        />
                      </div>
                      <div class="w-36 space-y-1">
                        <Label class="text-xs">Type</Label>
                        <Select v-model="field.type" :disabled="field.system">
                          <SelectTrigger class="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem
                              v-for="t in FIELD_TYPES"
                              :key="t"
                              :value="t"
                            >
                              {{ t }}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div class="flex items-center gap-1.5 pb-1.5">
                        <Checkbox
                          :id="`cs-req-${idx}`"
                          v-model="field.required"
                          :disabled="field.system"
                        />
                        <Label :for="`cs-req-${idx}`" class="text-xs font-normal">
                          Required
                        </Label>
                      </div>
                      <Badge
                        v-if="field.system"
                        variant="secondary"
                        class="mb-1.5"
                      >
                        system
                      </Badge>
                      <Button
                        v-else
                        type="button"
                        variant="ghost"
                        size="icon"
                        class="h-8 w-8"
                        title="Drop field"
                        @click="removeField(idx)"
                      >
                        <X class="h-4 w-4" />
                      </Button>
                    </div>

                    <template v-if="!field.system">
                      <div
                        v-if="field.type === 'text'"
                        class="flex items-end gap-3"
                      >
                        <div class="flex-1 space-y-1">
                          <Label class="text-xs">Regex pattern (optional)</Label>
                          <Input
                            v-model="field.regex"
                            placeholder="^[a-z]+$"
                            class="h-8 font-mono text-xs"
                          />
                        </div>
                        <div class="flex items-center gap-1.5 pb-1.5">
                          <Checkbox
                            :id="`cs-trim-${idx}`"
                            v-model="field.trim_input"
                          />
                          <Label
                            :for="`cs-trim-${idx}`"
                            class="text-xs font-normal"
                          >
                            Trim input
                          </Label>
                        </div>
                      </div>

                      <div
                        v-else-if="field.type === 'number'"
                        class="flex items-end gap-3"
                      >
                        <div class="w-24 space-y-1">
                          <Label class="text-xs">Min</Label>
                          <Input v-model="field.min" type="number" class="h-8" />
                        </div>
                        <div class="w-24 space-y-1">
                          <Label class="text-xs">Max</Label>
                          <Input v-model="field.max" type="number" class="h-8" />
                        </div>
                        <div class="flex items-center gap-1.5 pb-1.5">
                          <Checkbox
                            :id="`cs-nonzero-${idx}`"
                            v-model="field.nonzero"
                          />
                          <Label
                            :for="`cs-nonzero-${idx}`"
                            class="text-xs font-normal"
                          >
                            Non-zero
                          </Label>
                        </div>
                      </div>

                      <div
                        v-else-if="field.type === 'date_only'"
                        class="w-48 space-y-1"
                      >
                        <Label class="text-xs">Date format</Label>
                        <Select v-model="field.date_format">
                          <SelectTrigger class="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem
                              v-for="fmt in DATE_FORMATS"
                              :key="fmt"
                              :value="fmt"
                            >
                              {{ fmt }}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      <div
                        v-else-if="field.type === 'relation'"
                        class="w-64 space-y-1"
                      >
                        <Label class="text-xs">Related collection</Label>
                        <Input
                          v-model="field.relation_collection"
                          placeholder="collection_name"
                          class="h-8"
                        />
                      </div>
                    </template>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    @click="addField"
                  >
                    <Plus class="h-4 w-4" />
                    New field
                  </Button>
                </div>

                <div class="space-y-3">
                  <h3 class="text-sm font-semibold">Indexes</h3>
                  <p class="text-xs text-muted-foreground">
                    Add indexes to create on save. Existing indexes are not
                    listed here.
                  </p>
                  <div
                    v-for="(index, idx) in indexes"
                    :key="idx"
                    class="flex items-end gap-3"
                  >
                    <div class="flex-1 space-y-1">
                      <Label class="text-xs">Fields (comma-separated)</Label>
                      <Input
                        v-model="index.fields"
                        placeholder="title, created_at"
                        class="h-8"
                      />
                    </div>
                    <div class="w-32 space-y-1">
                      <Label class="text-xs">Type</Label>
                      <Select v-model="index.type">
                        <SelectTrigger class="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="index">Index</SelectItem>
                          <SelectItem value="unique">Unique</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      class="h-8 w-8"
                      title="Remove index"
                      @click="removeIndex(idx)"
                    >
                      <X class="h-4 w-4" />
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    @click="addIndex"
                  >
                    <Plus class="h-4 w-4" />
                    New index
                  </Button>
                </div>
              </template>
            </TabsContent>

            <TabsContent value="rules" class="space-y-5 pt-2">
              <div v-if="isAuth" class="space-y-4 rounded-md border p-3">
                <h3 class="text-sm font-semibold">Auth options</h3>
                <div class="flex items-end gap-6">
                  <div class="w-48 space-y-1.5">
                    <Label>Auth method</Label>
                    <Select v-model="authMethod">
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="email">Email</SelectItem>
                        <SelectItem value="username">Username</SelectItem>
                        <SelectItem value="both">Both</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="flex items-center gap-2 pb-1.5">
                    <Checkbox id="cs-google" v-model="googleEnabled" />
                    <Label for="cs-google" class="font-normal">
                      Enable Google OAuth
                    </Label>
                  </div>
                </div>
              </div>

              <div v-for="rule in ruleFields" :key="rule.key" class="space-y-1.5">
                <div class="flex items-center justify-between">
                  <Label>
                    {{ rule.label }}
                    <span class="text-xs text-muted-foreground/70">
                      (Admin only by default)
                    </span>
                  </Label>
                  <div class="flex items-center gap-2">
                    <Checkbox
                      :id="'cs-public-' + rule.key"
                      v-model="publicRules[rule.key]"
                    />
                    <Label :for="'cs-public-' + rule.key" class="text-xs font-normal text-muted-foreground">
                      Public
                    </Label>
                  </div>
                </div>
                <CodeEditor
                  v-if="!publicRules[rule.key]"
                  v-model="rules[rule.key]"
                  language="plain"
                  min-height="56px"
                  placeholder="@request.auth.id != ''"
                />
                <p v-else class="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                  No rule — anyone can perform this action.
                </p>
              </div>
            </TabsContent>
          </Tabs>

          <!-- Danger zone -->
          <div class="rounded-md border border-destructive/40 p-4">
            <h3 class="text-sm font-semibold text-destructive">Danger zone</h3>
            <p class="mt-1 text-xs text-muted-foreground">
              Permanently delete this collection and all of its records.
            </p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              class="mt-3"
              @click="deleteConfirmOpen = true"
            >
              Delete collection
            </Button>
          </div>
        </div>

        <div class="flex justify-end gap-3 border-t bg-muted/10 p-4">
          <Button type="button" variant="ghost" @click="open = false">
            Cancel
          </Button>
          <Button type="submit" :disabled="saving || !name.trim()">
            <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
            Save changes
          </Button>
        </div>
      </form>

      <AlertDialog v-model:open="deleteConfirmOpen">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this collection?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently drops
              <span class="font-mono">{{ collectionName }}</span> and all of its
              records. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              :disabled="deleting"
              @click="onDeleteCollection"
            >
              Delete collection
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SheetContent>
  </Sheet>
</template>
