<script setup lang="ts">
import { ref } from "vue";
import { CircleAlert, Loader2, Play } from "lucide-vue-next";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import CodeEditor from "@/components/CodeEditor.vue";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface SqlResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

const query = ref("SELECT * FROM _collections LIMIT 20;");
const running = ref(false);
const result = ref<SqlResult | null>(null);
const error = ref("");

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

async function runQuery() {
  if (!query.value.trim() || running.value) return;
  running.value = true;
  error.value = "";
  result.value = null;
  try {
    result.value = await api.post<SqlResult>("/internal/api/admin/sql-explorer", {
      query: query.value,
    });
  } catch (err) {
    error.value =
      err instanceof ApiError ? err.message : "Failed to execute query.";
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
    <div class="border-b pb-4">
      <p class="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
        Tools
      </p>
      <h2 class="mt-1 text-2xl font-semibold tracking-tight">SQL Explorer</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Run read-only SQL queries against the database.
      </p>
    </div>

    <div class="space-y-3">
      <CodeEditor
        v-model="query"
        language="sql"
        min-height="110px"
        placeholder="SELECT * FROM _collections LIMIT 20;"
        @run="runQuery"
      />
      <div class="flex items-center gap-3">
        <Button :disabled="running || !query.trim()" data-testid="sql-run" @click="runQuery">
          <Loader2 v-if="running" class="h-4 w-4 animate-spin" />
          <Play v-else class="h-4 w-4" />
          Run Query
        </Button>
        <span class="text-xs text-muted-foreground">
          Press Ctrl/Cmd + Enter to run. Only read-only SELECT queries are
          allowed.
        </span>
      </div>
    </div>

    <div
      v-if="error"
      class="flex items-start gap-2 rounded-md border border-foreground/30 bg-muted p-4 font-mono text-sm text-foreground"
      data-testid="sql-error"
    >
      <CircleAlert class="mt-0.5 h-4 w-4 shrink-0" />
      <div class="whitespace-pre-wrap">{{ error }}</div>
    </div>

    <template v-if="result">
      <div
        v-if="result.columns.length === 0"
        class="rounded-md border p-4 text-sm text-muted-foreground"
      >
        Query executed successfully — no rows returned.
      </div>
      <div v-else class="min-h-0 overflow-auto rounded-lg border" data-testid="sql-results">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead
                v-for="col in result.columns"
                :key="col"
                class="font-mono text-xs"
              >
                {{ col }}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="(row, rowIdx) in result.rows" :key="rowIdx">
              <TableCell
                v-for="(cell, cellIdx) in row"
                :key="cellIdx"
                class="max-w-72 truncate font-mono text-xs"
                :title="formatCell(cell)"
              >
                <span :class="cell === null ? 'text-muted-foreground' : ''">
                  {{ formatCell(cell) }}
                </span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p class="text-xs text-muted-foreground" data-testid="sql-footer">
        {{ result.rowCount }} row(s) in {{ result.durationMs }}ms
        <span v-if="result.truncated"> · truncated at 500 rows</span>
      </p>
    </template>
  </div>
</template>
