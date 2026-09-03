<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { FileCode2, Loader2, Plus, Save, Trash2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import CodeEditor from "@/components/CodeEditor.vue";
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

interface EndpointFile {
  name: string;
  sizeBytes: number;
  updatedAt: string;
}

interface EndpointRoute {
  method: string;
  path: string;
}

// Trimmed version of the legacy default script template.
const NEW_FILE_TEMPLATE = `// routerAdd and cronAdd are available in every custom endpoint file.
// Use await c.collection("posts") to get a collection with list, get, create, update, delete methods + rule properties.
// Use c.transaction(async ({ sql, db }) => ...) for atomic multi-query writes.
// Custom routes bypass collection API rules by default; call c.canAccessCollection(...) when you need rule enforcement.
// Error helpers available globally: ForbiddenError, BadRequestError, UnauthorizedError, NotFoundError, ConflictError.

routerAdd("GET", "/api/hello", (c) => {
  return c.json({ message: "Hello from custom endpoints" });
});
`;

const router = useRouter();

const enabled = ref(true);
const files = ref<EndpointFile[]>([]);
const routes = ref<EndpointRoute[]>([]);
const loadingList = ref(true);

const activeName = ref<string | null>(null);
const isNew = ref(false);
const fileName = ref("");
const content = ref("");
const loadingFile = ref(false);
const saving = ref(false);
const deleting = ref(false);
const deleteConfirmOpen = ref(false);

function errorMessage(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

async function loadList() {
  loadingList.value = true;
  try {
    const data = await api.get<{
      enabled: boolean;
      files: EndpointFile[];
      routes: EndpointRoute[];
    }>("/internal/api/admin/custom-endpoints");
    enabled.value = data.enabled;
    files.value = data.files;
    routes.value = data.routes;
  } catch (err) {
    toast.error(errorMessage(err, "Failed to load custom endpoints."));
  } finally {
    loadingList.value = false;
  }
}

async function openFile(name: string) {
  loadingFile.value = true;
  try {
    const data = await api.get<{ name: string; content: string }>(
      `/internal/api/admin/custom-endpoints/${encodeURIComponent(name)}`,
    );
    activeName.value = data.name;
    isNew.value = false;
    fileName.value = data.name;
    content.value = data.content;
  } catch (err) {
    toast.error(errorMessage(err, "Failed to load file."));
  } finally {
    loadingFile.value = false;
  }
}

function newFile() {
  activeName.value = null;
  isNew.value = true;
  fileName.value = "";
  content.value = NEW_FILE_TEMPLATE;
}

async function save() {
  if (!fileName.value.trim()) {
    toast.error("File name is required.");
    return;
  }
  saving.value = true;
  try {
    const data = await api.post<{ ok: boolean; name: string }>(
      "/internal/api/admin/custom-endpoints",
      {
        name: fileName.value.trim(),
        content: content.value,
        originalName: isNew.value ? undefined : (activeName.value ?? undefined),
      },
    );
    toast.success(`Saved ${data.name}.`);
    activeName.value = data.name;
    isNew.value = false;
    fileName.value = data.name;
    await loadList();
  } catch (err) {
    toast.error(errorMessage(err, "Failed to save file."));
  } finally {
    saving.value = false;
  }
}

async function deleteFile() {
  if (!activeName.value) return;
  deleting.value = true;
  try {
    await api.post("/internal/api/admin/custom-endpoints/delete", {
      name: activeName.value,
    });
    toast.success(`Deleted ${activeName.value}.`);
    deleteConfirmOpen.value = false;
    activeName.value = null;
    isNew.value = false;
    fileName.value = "";
    content.value = "";
    await loadList();
  } catch (err) {
    toast.error(errorMessage(err, "Failed to delete file."));
  } finally {
    deleting.value = false;
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

onMounted(loadList);
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- File list -->
    <aside class="flex w-64 shrink-0 flex-col border-r bg-card/50">
      <div class="flex items-center justify-between border-b px-4 pb-2 pt-4">
        <h2 class="text-sm font-semibold tracking-tight">Custom Endpoints</h2>
        <Button
          variant="ghost"
          size="icon"
          class="h-7 w-7"
          title="New file"
          data-testid="ce-new-file"
          @click="newFile"
        >
          <Plus class="h-4 w-4" />
        </Button>
      </div>

      <div
        v-if="!loadingList && !enabled"
        class="border-b bg-muted px-4 py-3 text-xs text-muted-foreground"
        data-testid="ce-disabled-banner"
      >
        Custom endpoints are disabled.
        <button
          type="button"
          class="font-semibold underline"
          @click="router.push('/settings')"
        >
          Enable them in Settings
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-2 py-2">
        <p
          v-if="loadingList"
          class="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground"
        >
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
          Loading…
        </p>
        <p
          v-else-if="files.length === 0"
          class="px-2 py-4 text-xs text-muted-foreground"
        >
          No endpoint files yet. Create one to get started.
        </p>
        <div
          v-for="file in files"
          :key="file.name"
          role="button"
          tabindex="0"
          :data-file="file.name"
          :class="[
            'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60',
            activeName === file.name
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-foreground/80',
          ]"
          @click="openFile(file.name)"
          @keydown.enter="openFile(file.name)"
        >
          <FileCode2 class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate font-mono text-xs">
            {{ file.name }}
          </span>
          <span class="text-[0.65rem] text-muted-foreground">
            {{ formatBytes(file.sizeBytes) }}
          </span>
        </div>
      </div>

      <div v-if="routes.length > 0" class="border-t px-3 py-2">
        <p class="mb-1 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground">
          Registered routes
        </p>
        <div class="max-h-32 space-y-0.5 overflow-y-auto">
          <p
            v-for="route in routes"
            :key="`${route.method}-${route.path}`"
            class="truncate font-mono text-[0.65rem] text-muted-foreground"
            :title="`${route.method} ${route.path}`"
          >
            {{ route.method }} {{ route.path }}
          </p>
        </div>
      </div>
    </aside>

    <!-- Editor pane -->
    <div class="flex min-w-0 flex-1 flex-col">
      <div
        v-if="!isNew && !activeName"
        class="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground"
      >
        Select a file on the left, or create a new one.
      </div>

      <template v-else>
        <div class="flex items-center gap-3 border-b px-4 py-3">
          <Input
            v-model="fileName"
            class="h-8 w-72 font-mono text-xs"
            placeholder="example.gs.js"
            data-testid="ce-filename"
          />
          <Badge v-if="isNew" variant="secondary">new</Badge>
          <div class="ml-auto flex items-center gap-2">
            <Button
              v-if="!isNew"
              variant="ghost"
              size="icon"
              class="h-8 w-8 text-destructive hover:text-destructive"
              title="Delete file"
              data-testid="ce-delete"
              @click="deleteConfirmOpen = true"
            >
              <Trash2 class="h-4 w-4" />
            </Button>
            <Button
              size="sm"
              :disabled="saving || loadingFile"
              data-testid="ce-save"
              @click="save"
            >
              <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
              <Save v-else class="h-4 w-4" />
              Save
            </Button>
          </div>
        </div>

        <div v-if="loadingFile" class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          Loading file…
        </div>
        <div v-else class="min-h-0 flex-1 overflow-y-auto p-4">
          <CodeEditor
            v-model="content"
            language="javascript"
            min-height="100%"
            placeholder="// routerAdd('GET', '/api/hello', (c) => c.json({ ok: true }))"
          />
          <p class="mt-3 text-xs text-muted-foreground">
            Use
            <code class="rounded bg-muted px-1 font-mono">routerAdd("METHOD", "/api/path/:id", (c) =&gt; ...)</code>,
            <code class="rounded bg-muted px-1 font-mono">c.collection("posts")</code>,
            <code class="rounded bg-muted px-1 font-mono">c.transaction(async ({ sql, db }) =&gt; ...)</code>
            and
            <code class="rounded bg-muted px-1 font-mono">cronAdd("* * * * *", async ({ sql, db }) =&gt; ...)</code>.
          </p>
        </div>
      </template>
    </div>

    <AlertDialog v-model:open="deleteConfirmOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this endpoint file?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes
            <span class="font-mono">{{ activeName }}</span>
            and unregisters its routes and cron jobs.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            :disabled="deleting"
            data-testid="ce-delete-confirm"
            @click="deleteFile"
          >
            Delete file
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
