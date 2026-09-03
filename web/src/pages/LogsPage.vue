<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Radio, RefreshCw } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface LogEntry {
  id?: number | string;
  method: string;
  url?: string;
  path?: string;
  status: number;
  error: string | null;
  collection: string | null;
  user_ip?: string | null;
  user_agent?: string | null;
  created_at: string;
}

const MAX_LOGS = 200;

const logs = ref<LogEntry[]>([]);
const loading = ref(false);
const live = ref(false);
const liveConnected = ref(false);

let socket: WebSocket | null = null;
let liveIdCounter = 0;

function methodBadgeClass(method: string) {
  switch (method.toUpperCase()) {
    case "GET":
      return "border-border bg-muted text-foreground";
    case "POST":
      return "border-border bg-muted text-muted-foreground";
    case "PATCH":
    case "PUT":
      return "border-foreground/30 bg-muted text-foreground";
    case "DELETE":
      return "border-foreground bg-foreground text-background";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function statusBadgeClass(status: number) {
  if (status >= 500) {
    return "border-foreground bg-foreground text-background";
  }
  if (status >= 400) {
    return "border-foreground/30 bg-muted text-foreground";
  }
  if (status >= 200 && status < 300) {
    return "border-border bg-muted text-muted-foreground";
  }
  return "border-border bg-muted text-muted-foreground";
}

function truncate(value: string | null | undefined, max: number) {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatTime(iso: string) {
  const date = new Date(iso);
  return isNaN(date.getTime()) ? iso : date.toLocaleString();
}

async function loadLogs() {
  loading.value = true;
  try {
    const data = await api.get<{ logs: LogEntry[] }>("/internal/api/admin/logs");
    logs.value = data.logs;
  } catch (err) {
    toast.error(err instanceof ApiError ? err.message : "Failed to load logs.");
  } finally {
    loading.value = false;
  }
}

function closeSocket() {
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
    socket = null;
  }
  liveConnected.value = false;
}

function openSocket() {
  closeSocket();
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${window.location.host}/api/logs/stream`);
  socket.onopen = () => {
    liveConnected.value = true;
  };
  socket.onmessage = (event) => {
    try {
      const entry = JSON.parse(String(event.data)) as LogEntry;
      logs.value = [
        {
          id: `live-${++liveIdCounter}`,
          method: entry.method,
          url: entry.path ?? entry.url ?? "",
          status: entry.status,
          error: entry.error ?? null,
          collection: entry.collection ?? null,
          user_ip: null,
          user_agent: null,
          created_at: entry.created_at ?? new Date().toISOString(),
        },
        ...logs.value,
      ].slice(0, MAX_LOGS);
    } catch {
      // Ignore malformed frames.
    }
  };
  socket.onclose = () => {
    liveConnected.value = false;
    // If the toggle is still on (server dropped us), try to reconnect.
    if (live.value) {
      setTimeout(() => {
        if (live.value) openSocket();
      }, 2000);
    }
  };
  socket.onerror = () => {
    liveConnected.value = false;
  };
}

watch(live, (on) => {
  if (on) openSocket();
  else closeSocket();
});

onMounted(loadLogs);

onBeforeUnmount(() => {
  closeSocket();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col p-6">
    <div class="mb-4 flex items-center justify-between border-b pb-4">
      <div>
        <p class="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
          System
        </p>
        <h2 class="mt-1 text-2xl font-semibold tracking-tight">Logs</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          The 100 most recent requests, newest first.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :data-active="live"
          :class="
            live
              ? 'border-foreground bg-foreground text-background hover:bg-foreground/90'
              : ''
          "
          @click="live = !live"
        >
          <Radio class="h-4 w-4" :class="live && liveConnected ? 'animate-pulse' : ''" />
          {{ live ? (liveConnected ? "Live" : "Connecting…") : "Go Live" }}
        </Button>
        <Button variant="outline" size="sm" :disabled="loading" @click="loadLogs">
          <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" />
          Refresh
        </Button>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="w-24">Method</TableHead>
            <TableHead>URL</TableHead>
            <TableHead class="w-20">Status</TableHead>
            <TableHead class="w-28">Collection</TableHead>
            <TableHead class="w-28">IP</TableHead>
            <TableHead class="w-40">User Agent</TableHead>
            <TableHead class="w-44">Time</TableHead>
            <TableHead class="w-40">Error</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-if="logs.length === 0 && !loading">
            <TableCell colspan="8" class="py-8 text-center text-sm text-muted-foreground">
              No logs recorded yet.
            </TableCell>
          </TableRow>
          <TableRow v-for="log in logs" :key="log.id ?? `${log.created_at}-${log.url}`">
            <TableCell>
              <Badge variant="outline" :class="methodBadgeClass(log.method)">
                {{ log.method }}
              </Badge>
            </TableCell>
            <TableCell
              class="max-w-0 truncate font-mono text-xs"
              :title="log.url ?? log.path ?? ''"
            >
              {{ log.url ?? log.path ?? "" }}
            </TableCell>
            <TableCell>
              <Badge variant="outline" :class="statusBadgeClass(log.status)">
                {{ log.status }}
              </Badge>
            </TableCell>
            <TableCell class="text-xs">
              {{ log.collection ?? "—" }}
            </TableCell>
            <TableCell class="text-xs text-muted-foreground">
              {{ log.user_ip ?? "—" }}
            </TableCell>
            <TableCell
              class="max-w-0 truncate text-xs text-muted-foreground"
              :title="log.user_agent ?? ''"
            >
              {{ truncate(log.user_agent, 30) || "—" }}
            </TableCell>
            <TableCell class="whitespace-nowrap text-xs text-muted-foreground">
              {{ formatTime(log.created_at) }}
            </TableCell>
            <TableCell
              class="max-w-0 truncate text-xs text-destructive"
              :title="log.error ?? ''"
            >
              {{ truncate(log.error, 40) || "—" }}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  </div>
</template>
