<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { Loader2, Plus, Send, X } from "lucide-vue-next";
import { useCollectionsStore } from "@/stores/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;

interface HeaderRow {
  key: string;
  value: string;
}

const store = useCollectionsStore();

const collections = computed(() =>
  store.collections.filter((c) => c.type !== "view"),
);

const collection = ref("");
const method = ref<(typeof METHODS)[number]>("GET");
const recordId = ref("");
const url = ref("");
const headers = reactive<HeaderRow[]>([]);
const body = ref("");
const sending = ref(false);

const responseStatus = ref<number | null>(null);
const responseStatusText = ref("");
const responseDuration = ref<number | null>(null);
const responseBody = ref("");
const responseOk = ref(false);
const clientError = ref("");

// Auto-build the URL from collection + method + record id, mirroring the
// legacy tester (the URL input stays editable for free-form requests).
function rebuildUrl() {
  if (!collection.value) {
    url.value = "";
    return;
  }
  let next = `/api/collections/${collection.value}/records`;
  if (recordId.value.trim() && method.value !== "POST") {
    next += `/${recordId.value.trim()}`;
  }
  url.value = next;
}

watch([collection, method, recordId], rebuildUrl);

store.fetchAll();

const showBody = computed(() => method.value === "POST" || method.value === "PATCH");

function addHeader() {
  headers.push({ key: "", value: "" });
}

function removeHeader(idx: number) {
  headers.splice(idx, 1);
}

function statusBadgeClass(ok: boolean) {
  return ok
    ? "border-border bg-muted text-muted-foreground"
    : "border-foreground bg-foreground text-background";
}

async function send() {
  clientError.value = "";
  responseStatus.value = null;
  responseBody.value = "";

  if (!url.value.trim()) {
    clientError.value = "URL is required.";
    return;
  }

  const requestHeaders: Record<string, string> = {};
  for (const row of headers) {
    if (row.key.trim()) requestHeaders[row.key.trim()] = row.value;
  }

  let requestBody: string | undefined;
  if (showBody.value && body.value.trim()) {
    try {
      requestBody = JSON.stringify(JSON.parse(body.value));
      requestHeaders["Content-Type"] = "application/json";
    } catch (err) {
      clientError.value = `Error parsing body JSON: ${(err as Error).message}`;
      return;
    }
  }

  sending.value = true;
  try {
    const start = performance.now();
    const res = await fetch(url.value, {
      method: method.value,
      headers: requestHeaders,
      body: requestBody,
      credentials: "same-origin",
    });
    responseDuration.value = Math.round(performance.now() - start);
    responseStatus.value = res.status;
    responseStatusText.value = res.statusText;
    responseOk.value = res.ok;

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      responseBody.value = JSON.stringify(data, null, 2);
    } else {
      responseBody.value = await res.text();
    }
  } catch (err) {
    clientError.value = `Network error: ${(err as Error).message}`;
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto p-6">
    <div class="mb-6 border-b pb-4">
      <p class="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        Tools
      </p>
      <h2 class="mt-1 text-2xl font-semibold tracking-tight">API Tester</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Test your public collection endpoints directly from the browser.
      </p>
    </div>

    <div class="flex flex-col gap-6 lg:flex-row">
      <!-- Request panel -->
      <div class="space-y-4 lg:w-1/2 lg:border-r lg:pr-6">
        <div class="space-y-1.5">
          <Label>Collection</Label>
          <Select v-model="collection">
            <SelectTrigger data-testid="api-tester-collection">
              <SelectValue placeholder="-- Select Collection --" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="col in collections"
                :key="col.name"
                :value="col.name"
              >
                {{ col.name }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="flex gap-2">
          <Select v-model="method">
            <SelectTrigger class="w-28 font-mono" data-testid="api-tester-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="m in METHODS" :key="m" :value="m">
                {{ m }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Input
            v-model="url"
            class="flex-1 font-mono text-xs"
            placeholder="/api/collections/posts/records"
            data-testid="api-tester-url"
          />
        </div>

        <div v-if="method !== 'POST'" class="space-y-1.5">
          <Label for="api-tester-record-id">Record ID (optional)</Label>
          <Input
            id="api-tester-record-id"
            v-model="recordId"
            class="font-mono text-xs"
            placeholder="Leave empty to list records"
          />
        </div>

        <div class="space-y-2">
          <Label>Headers</Label>
          <div
            v-for="(header, idx) in headers"
            :key="idx"
            class="flex items-center gap-2"
          >
            <Input
              v-model="header.key"
              class="h-8 flex-1 font-mono text-xs"
              placeholder="Header name"
            />
            <Input
              v-model="header.value"
              class="h-8 flex-1 font-mono text-xs"
              placeholder="Value"
            />
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8"
              title="Remove header"
              @click="removeHeader(idx)"
            >
              <X class="h-4 w-4" />
            </Button>
          </div>
          <Button variant="outline" size="sm" @click="addHeader">
            <Plus class="h-4 w-4" />
            Add header
          </Button>
        </div>

        <div v-if="showBody" class="space-y-1.5">
          <Label for="api-tester-body">Body (JSON)</Label>
          <Textarea
            id="api-tester-body"
            v-model="body"
            rows="7"
            class="font-mono text-xs"
            placeholder='{ "key": "value" }'
          />
        </div>

        <p v-if="clientError" class="text-sm text-destructive" data-testid="api-tester-error">
          {{ clientError }}
        </p>

        <div class="flex justify-end pt-1">
          <Button :disabled="sending" data-testid="api-tester-send" @click="send">
            <Loader2 v-if="sending" class="h-4 w-4 animate-spin" />
            <Send v-else class="h-4 w-4" />
            Send Request
          </Button>
        </div>
      </div>

      <!-- Response panel -->
      <div class="flex flex-col lg:w-1/2">
        <div class="mb-2 flex items-center justify-between">
          <Label>Response</Label>
          <Badge
            v-if="responseStatus !== null"
            variant="outline"
            :class="statusBadgeClass(responseOk)"
            data-testid="api-tester-status"
          >
            {{ responseStatus }} {{ responseStatusText }}
            <span v-if="responseDuration !== null"> · {{ responseDuration }}ms</span>
          </Badge>
          <Badge v-else variant="secondary">Status: ---</Badge>
        </div>
        <pre
          class="min-h-80 flex-1 overflow-auto rounded-lg border bg-muted/20 p-4 font-mono text-xs text-foreground"
          data-testid="api-tester-response"
        >{{ responseBody || "Response will appear here..." }}</pre>
      </div>
    </div>
  </div>
</template>
