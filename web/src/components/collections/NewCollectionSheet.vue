<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { Loader2, Plus, X } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { api, ApiError } from "@/lib/api";
import { useCollectionsStore } from "@/stores/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
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

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const router = useRouter();
const store = useCollectionsStore();

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

const name = ref("");
const type = ref<"base" | "auth" | "view">("base");
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
// A rule stored as "" means public; absent/null means admin-only. These flags
// keep that distinction, which the empty editor alone cannot express.
const publicRules = reactive({
  list_rule: false,
  view_rule: false,
  create_rule: false,
  update_rule: false,
  delete_rule: false,
});
const saving = ref(false);

function newFieldRow(): FieldRow {
  return {
    name: "",
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

function resetForm() {
  name.value = "";
  type.value = "base";
  viewQuery.value = "";
  authMethod.value = "email";
  googleEnabled.value = false;
  fields.splice(0, fields.length, newFieldRow());
  indexes.splice(0, indexes.length);
  Object.keys(rules).forEach((k) => (rules[k as keyof typeof rules] = ""));
  Object.keys(publicRules).forEach(
    (k) => (publicRules[k as keyof typeof publicRules] = false),
  );
}

watch(
  () => props.open,
  (open) => {
    if (open) resetForm();
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
  const payload: Record<string, unknown> = {
    name: name.value,
    type: type.value,
  };

  if (type.value === "view") {
    payload.view_query = viewQuery.value;
  } else {
    payload.fields = fields
      .filter((f) => f.name.trim())
      .map((f) => {
        const out: Record<string, unknown> = {
          name: f.name,
          type: f.type,
          required: f.required,
        };
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

  if (type.value === "auth") {
    payload.auth_method = authMethod.value;
    payload.google_enabled = googleEnabled.value;
  }

  for (const [key, value] of Object.entries(rules)) {
    const k = key as keyof typeof rules;
    if (publicRules[k]) payload[key] = "";
    else if (value.trim()) payload[key] = value;
  }

  saving.value = true;
  try {
    const data = await api.post<{ collection: { name: string } }>(
      "/internal/api/admin/collections",
      payload,
    );
    toast.success("Collection created.");
    emit("update:open", false);
    await store.refresh();
    router.push(`/collections/${data.collection.name}`);
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Failed to create collection.",
    );
  } finally {
    saving.value = false;
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
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent class="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
      <SheetHeader class="border-b px-6 py-4">
        <SheetTitle>New Collection</SheetTitle>
        <SheetDescription>
          Create a new base, auth or view collection.
        </SheetDescription>
      </SheetHeader>

      <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="onSubmit">
        <div class="flex-1 space-y-6 overflow-y-auto p-6">
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-1.5">
              <Label for="nc-name">Name</Label>
              <Input
                id="nc-name"
                v-model="name"
                required
                placeholder="posts"
                title="Only alphanumeric characters and underscores allowed. Spaces will be converted."
              />
            </div>
            <div class="space-y-1.5">
              <Label for="nc-type">Type</Label>
              <Select v-model="type">
                <SelectTrigger id="nc-type">
                  <SelectValue placeholder="Select a type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="base">Base</SelectItem>
                  <SelectItem value="auth">Auth</SelectItem>
                  <SelectItem value="view">View</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Tabs default-value="fields">
            <TabsList>
              <TabsTrigger value="fields">Fields</TabsTrigger>
              <TabsTrigger value="rules">Rules &amp; Options</TabsTrigger>
            </TabsList>

            <TabsContent value="fields" class="space-y-6 pt-2">
              <template v-if="type === 'view'">
                <div class="space-y-1.5">
                  <Label for="nc-view-query">SQL query</Label>
                  <Textarea
                    id="nc-view-query"
                    v-model="viewQuery"
                    rows="6"
                    class="font-mono text-xs"
                    placeholder="SELECT id, created_at, email FROM users"
                  />
                  <p class="text-xs text-muted-foreground">
                    A read-only Postgres view is created from this SELECT query.
                  </p>
                </div>
              </template>

              <template v-else>
                <div class="space-y-3">
                  <div class="flex items-center justify-between">
                    <h3 class="text-sm font-semibold">Fields</h3>
                  </div>
                  <p
                    v-if="type === 'auth'"
                    class="text-xs text-muted-foreground"
                  >
                    Auth collections automatically include id, email/username,
                    verified, password, created and updated fields.
                  </p>

                  <div
                    v-for="(field, idx) in fields"
                    :key="idx"
                    class="space-y-3 rounded-md border p-3"
                  >
                    <div class="flex items-end gap-3">
                      <div class="flex-1 space-y-1">
                        <Label class="text-xs">Name</Label>
                        <Input
                          v-model="field.name"
                          placeholder="field_name"
                          class="h-8"
                        />
                      </div>
                      <div class="w-36 space-y-1">
                        <Label class="text-xs">Type</Label>
                        <Select v-model="field.type">
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
                          :id="`nc-req-${idx}`"
                          v-model="field.required"
                        />
                        <Label :for="`nc-req-${idx}`" class="text-xs font-normal">
                          Required
                        </Label>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        class="h-8 w-8"
                        title="Remove field"
                        @click="removeField(idx)"
                      >
                        <X class="h-4 w-4" />
                      </Button>
                    </div>

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
                          :id="`nc-trim-${idx}`"
                          v-model="field.trim_input"
                        />
                        <Label :for="`nc-trim-${idx}`" class="text-xs font-normal">
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
                          :id="`nc-nonzero-${idx}`"
                          v-model="field.nonzero"
                        />
                        <Label
                          :for="`nc-nonzero-${idx}`"
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
                  <div
                    v-for="(index, idx) in indexes"
                    :key="idx"
                    class="flex items-end gap-3"
                  >
                    <div class="flex-1 space-y-1">
                      <Label class="text-xs">
                        Fields (comma-separated)
                      </Label>
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
              <div v-if="type === 'auth'" class="space-y-4 rounded-md border p-3">
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
                    <Checkbox id="nc-google" v-model="googleEnabled" />
                    <Label for="nc-google" class="font-normal">
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
                      :id="'nc-public-' + rule.key"
                      v-model="publicRules[rule.key]"
                    />
                    <Label :for="'nc-public-' + rule.key" class="text-xs font-normal text-muted-foreground">
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
        </div>

        <div class="flex justify-end gap-3 border-t bg-muted/10 p-4">
          <Button type="button" variant="ghost" @click="emit('update:open', false)">
            Cancel
          </Button>
          <Button type="submit" :disabled="saving || !name.trim()">
            <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
            Create collection
          </Button>
        </div>
      </form>
    </SheetContent>
  </Sheet>
</template>
