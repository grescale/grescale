<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { Loader2, Trash2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { api, ApiError } from "@/lib/api";
import { useCollectionsStore, type CollectionMeta, type FieldDef } from "@/stores/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
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

const props = defineProps<{
  open: boolean;
  collectionName: string;
  record: Record<string, unknown> | null;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "saved"): void;
}>();

const store = useCollectionsStore();

const isEdit = computed(() => props.record !== null);
const isSystemUsers = computed(() => props.collectionName === "_users");

const meta = ref<CollectionMeta | null>(null);
const values = reactive<Record<string, unknown>>({});
const manualId = ref("");
const saving = ref(false);
const deleting = ref(false);
const errorMessage = ref("");
const deleteConfirmOpen = ref(false);

const isAuth = computed(
  () => isSystemUsers.value || meta.value?.type === "auth",
);
const authMethod = computed(
  () => meta.value?.oauth2?.auth_method || "email",
);

// Non-system schema fields rendered with type-specific inputs.
const customFields = computed<FieldDef[]>(() => {
  if (isSystemUsers.value || !meta.value) return [];
  return (meta.value.schema || []).filter((f) => !f.system);
});

function toLocalDateTimeInput(val: unknown): string {
  const d = new Date(String(val));
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toDateInput(val: unknown): string {
  const str = String(val ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(str);
  if (isNaN(d.getTime())) return str;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function prefill() {
  Object.keys(values).forEach((k) => delete values[k]);
  manualId.value = "";
  errorMessage.value = "";
  const rec = props.record;

  for (const field of customFields.value) {
    const raw = rec ? rec[field.name] : undefined;
    switch (field.type) {
      case "boolean":
        values[field.name] = raw === true || raw === "true";
        break;
      case "date":
        values[field.name] = rec && raw ? toLocalDateTimeInput(raw) : "";
        break;
      case "date_only":
        values[field.name] = rec && raw ? toDateInput(raw) : "";
        break;
      case "json":
        values[field.name] =
          rec && raw !== undefined && raw !== null
            ? typeof raw === "object"
              ? JSON.stringify(raw, null, 2)
              : String(raw)
            : "";
        break;
      default:
        values[field.name] = rec && raw !== undefined && raw !== null ? String(raw) : "";
    }
  }

  if (isAuth.value) {
    values.username = rec?.username ? String(rec.username) : "";
    values.email = rec?.email ? String(rec.email) : "";
    values.verified = rec?.verified === true || rec?.verified === "true";
    values.password = "";
    values.passwordConfirm = "";
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    meta.value = null;
    if (isSystemUsers.value) {
      meta.value = {
        name: "_users",
        type: "auth",
        schema: [],
        oauth2: { auth_method: "email" },
        view_query: null,
        list_rule: null,
        view_rule: null,
        create_rule: null,
        update_rule: null,
        delete_rule: null,
      };
    } else {
      const fromStore = store.collections.find(
        (c) => c.name === props.collectionName,
      );
      if (fromStore) {
        meta.value = fromStore;
      } else {
        try {
          const data = await api.get<{ collection: CollectionMeta }>(
            `/internal/api/admin/collections/${encodeURIComponent(props.collectionName)}`,
          );
          meta.value = data.collection;
        } catch (err) {
          errorMessage.value =
            err instanceof ApiError ? err.message : "Failed to load collection.";
        }
      }
    }
    prefill();
  },
);

async function onSubmit() {
  errorMessage.value = "";

  const body: Record<string, unknown> = {};

  if (isSystemUsers.value) {
    body.email = values.email;
    if (!isEdit.value || values.password) {
      body.password = values.password;
      body.passwordConfirm = values.passwordConfirm;
    }
    if (
      isEdit.value &&
      !values.password &&
      values.email === props.record?.email
    ) {
      errorMessage.value = "No changes to save.";
      return;
    }
  } else {
    for (const field of customFields.value) {
      const v = values[field.name];
      if (field.type === "boolean") {
        body[field.name] = v === true;
        continue;
      }
      if (v === "" || v === undefined || v === null) continue;
      if (field.type === "json") {
        try {
          JSON.parse(String(v));
        } catch {
          errorMessage.value = `Field "${field.name}" must be valid JSON.`;
          return;
        }
      }
      body[field.name] = v;
    }

    if (isAuth.value) {
      if (authMethod.value === "username" || authMethod.value === "both") {
        if (values.username) body.username = values.username;
      }
      if (authMethod.value === "email" || authMethod.value === "both") {
        if (values.email) body.email = values.email;
      }
      body.verified = values.verified === true;
      if (!isEdit.value || values.password) {
        body.password = values.password;
        body.passwordConfirm = values.passwordConfirm;
      }
    }

    if (!isEdit.value && manualId.value.trim()) {
      body.id = manualId.value.trim();
    }
  }

  saving.value = true;
  try {
    const base = `/internal/api/admin/collections/${encodeURIComponent(props.collectionName)}/records`;
    if (isEdit.value) {
      await api.post(`${base}/${props.record!.id}`, body);
      toast.success("Record updated.");
    } else {
      await api.post(base, body);
      toast.success("Record created.");
    }
    emit("saved");
  } catch (err) {
    const message =
      err instanceof ApiError ? err.message : "Failed to save record.";
    errorMessage.value = message;
    toast.error(message);
  } finally {
    saving.value = false;
  }
}

async function onDelete() {
  if (!props.record) return;
  deleting.value = true;
  try {
    await api.post(
      `/internal/api/admin/collections/${encodeURIComponent(props.collectionName)}/records/${props.record.id}/delete`,
    );
    toast.success("Record deleted.");
    deleteConfirmOpen.value = false;
    emit("saved");
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Failed to delete record.",
    );
  } finally {
    deleting.value = false;
  }
}

const inputTypeByField: Record<string, string> = {
  text: "text",
  email: "email",
  url: "text",
  number: "number",
  date: "datetime-local",
  date_only: "date",
  file: "text",
  relation: "text",
};
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent class="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
      <SheetHeader class="border-b px-6 py-4">
        <p
          class="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        >
          {{ collectionName }}
        </p>
        <SheetTitle>{{ isEdit ? "Edit Record" : "New Record" }}</SheetTitle>
        <SheetDescription v-if="isSystemUsers">
          Superadmin account
        </SheetDescription>
      </SheetHeader>

      <form class="flex min-h-0 flex-1 flex-col" @submit.prevent="onSubmit">
        <div class="flex-1 space-y-5 overflow-y-auto p-6">
          <div
            v-if="errorMessage"
            class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {{ errorMessage }}
          </div>

          <div v-if="!isEdit && !isSystemUsers" class="space-y-1.5">
            <Label for="rf-id">
              id
              <span class="text-xs text-muted-foreground/70">
                (optional UUID, auto-generated if blank)
              </span>
            </Label>
            <Input
              id="rf-id"
              v-model="manualId"
              placeholder="Leave blank to auto-generate"
            />
          </div>

          <!-- Auth fields -->
          <template v-if="isAuth">
            <div
              v-if="
                !isSystemUsers &&
                (authMethod === 'username' || authMethod === 'both')
              "
              class="space-y-1.5"
            >
              <Label for="rf-username">
                username
                <span class="text-xs text-muted-foreground/70">(required)</span>
              </Label>
              <Input id="rf-username" v-model="values.username as string" />
            </div>

            <div class="space-y-1.5">
              <Label for="rf-email">
                email
                <span class="text-xs text-muted-foreground/70">(required)</span>
              </Label>
              <Input id="rf-email" v-model="values.email as string" type="email" />
            </div>

            <div v-if="!isSystemUsers" class="flex items-center gap-2">
              <Checkbox
                id="rf-verified"
                v-model="values.verified as boolean"
              />
              <Label for="rf-verified" class="font-normal">
                Mark as verified
              </Label>
            </div>

            <div class="space-y-1.5">
              <Label for="rf-password">
                password
                <span class="text-xs text-muted-foreground/70">
                  (min 8 chars{{ isEdit ? ", leave blank to keep current" : "" }})
                </span>
              </Label>
              <Input
                id="rf-password"
                v-model="values.password as string"
                type="password"
                autocomplete="new-password"
              />
            </div>
            <div class="space-y-1.5">
              <Label for="rf-password-confirm">passwordConfirm</Label>
              <Input
                id="rf-password-confirm"
                v-model="values.passwordConfirm as string"
                type="password"
                autocomplete="new-password"
              />
            </div>
          </template>

          <!-- Schema-driven fields -->
          <div
            v-for="field in customFields"
            :key="field.name"
            class="space-y-1.5"
          >
            <template v-if="field.type === 'boolean'">
              <div class="flex items-center gap-2">
                <Checkbox
                  :id="`rf-${field.name}`"
                  v-model="values[field.name] as boolean"
                />
                <Label :for="`rf-${field.name}`" class="font-normal">
                  {{ field.name }}
                  <span class="text-xs text-muted-foreground/70">(boolean)</span>
                </Label>
              </div>
            </template>
            <template v-else-if="field.type === 'richtext' || field.type === 'json'">
              <Label :for="`rf-${field.name}`">
                {{ field.name }}
                <span class="text-xs text-muted-foreground/70">
                  ({{ field.type }}{{ field.required ? ", required" : "" }})
                </span>
              </Label>
              <Textarea
                :id="`rf-${field.name}`"
                v-model="values[field.name] as string"
                :rows="field.type === 'json' ? 4 : 6"
                :class="field.type === 'json' ? 'font-mono text-xs' : ''"
                :placeholder="
                  field.type === 'json' ? '{ }' : 'Write rich text HTML here...'
                "
              />
            </template>
            <template v-else>
              <Label :for="`rf-${field.name}`">
                {{ field.name }}
                <span class="text-xs text-muted-foreground/70">
                  ({{ field.type }}{{ field.required ? ", required" : "" }})
                </span>
              </Label>
              <Input
                :id="`rf-${field.name}`"
                v-model="values[field.name] as string"
                :type="inputTypeByField[field.type] ?? 'text'"
                :placeholder="
                  field.type === 'relation'
                    ? 'Related record UUID'
                    : field.type === 'file'
                      ? 'File path or URL'
                      : ''
                "
              />
            </template>
          </div>
        </div>

        <div
          class="flex items-center justify-between gap-3 border-t bg-muted/10 p-4"
        >
          <div>
            <Button
              v-if="isEdit"
              type="button"
              variant="destructive"
              size="sm"
              @click="deleteConfirmOpen = true"
            >
              <Trash2 class="h-4 w-4" />
              Delete
            </Button>
          </div>
          <div class="flex gap-3">
            <Button
              type="button"
              variant="ghost"
              @click="emit('update:open', false)"
            >
              Cancel
            </Button>
            <Button type="submit" :disabled="saving">
              <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
              {{ isEdit ? "Save changes" : "Save Record" }}
            </Button>
          </div>
        </div>
      </form>

      <AlertDialog v-model:open="deleteConfirmOpen">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the record from
              <span class="font-mono">{{ collectionName }}</span
              >. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              :disabled="deleting"
              @click="onDelete"
            >
              Delete record
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SheetContent>
  </Sheet>
</template>
