<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Plus,
  RefreshCw,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { api, ApiError } from "@/lib/api";
import { formatCellValue, shortId, visibleColumns } from "@/lib/format";
import { useCollectionsStore, type FieldDef } from "@/stores/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import RecordFormSheet from "@/components/records/RecordFormSheet.vue";

interface RecordsResponse {
  columns: { column_name: string; data_type: string }[];
  schema: FieldDef[];
  records: Record<string, unknown>[];
  page: number;
  perPage: number;
  hasMore: boolean;
}

const route = useRoute();
const router = useRouter();
const store = useCollectionsStore();

const collectionName = computed(() => String(route.params.name ?? ""));
const isView = computed(() => collection.value?.type === "view");
const collection = computed(() =>
  store.collections.find((c) => c.name === collectionName.value),
);

const columns = ref<string[]>([]);
const records = ref<Record<string, unknown>[]>([]);
const page = ref(1);
const hasMore = ref(false);
const loading = ref(false);
const loadError = ref("");

const filterInput = ref(
  typeof route.query.filter === "string" ? route.query.filter : "",
);
const sort = computed(() =>
  typeof route.query.sort === "string" ? route.query.sort : "",
);
const order = computed(() =>
  route.query.order === "asc" ? "asc" : "desc",
);

async function load(p: number, append: boolean) {
  loading.value = true;
  loadError.value = "";
  try {
    const params = new URLSearchParams();
    params.set("page", String(p));
    if (sort.value) {
      params.set("sort", sort.value);
      params.set("order", order.value);
    }
    if (typeof route.query.filter === "string" && route.query.filter) {
      params.set("filter", route.query.filter);
    }
    const data = await api.get<RecordsResponse>(
      `/internal/api/admin/collections/${encodeURIComponent(collectionName.value)}/records?${params.toString()}`,
    );
    columns.value = visibleColumns(
      data.columns.map((c) => c.column_name),
    );
    records.value = append ? [...records.value, ...data.records] : data.records;
    page.value = data.page;
    hasMore.value = data.hasMore;
  } catch (err) {
    const message =
      err instanceof ApiError ? err.message : "Failed to load records.";
    loadError.value = message;
    toast.error(message);
  } finally {
    loading.value = false;
  }
}

function syncQuery(patch: Record<string, string | undefined>) {
  router.replace({
    query: {
      ...route.query,
      ...patch,
    },
  });
}

function applyFilter() {
  syncQuery({ filter: filterInput.value || undefined });
}

function toggleSort(col: string) {
  if (sort.value === col) {
    syncQuery({ order: order.value === "asc" ? "desc" : "asc" });
  } else {
    syncQuery({ sort: col, order: "asc" });
  }
}

watch(
  () => [collectionName.value, route.query.filter, route.query.sort, route.query.order],
  () => {
    if (!collectionName.value) return;
    store.setCurrent(collectionName.value);
    records.value = [];
    load(1, false);
  },
  { immediate: true },
);

// Record sheet state
const recordSheetOpen = ref(false);
const editingRecord = ref<Record<string, unknown> | null>(null);

function openNewRecord() {
  editingRecord.value = null;
  recordSheetOpen.value = true;
}

function openEditRecord(record: Record<string, unknown>) {
  editingRecord.value = record;
  recordSheetOpen.value = true;
}

function onRecordSaved() {
  recordSheetOpen.value = false;
  load(1, false);
}

async function copyId(event: MouseEvent, id: unknown) {
  event.stopPropagation();
  try {
    await navigator.clipboard.writeText(String(id));
    toast.success("ID copied to clipboard.");
  } catch {
    toast.error("Could not copy ID.");
  }
}
</script>

<template>
  <div class="flex h-full flex-col p-6">
    <div class="mb-4 flex items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <h1 class="text-2xl font-semibold tracking-tight">
          {{ collectionName }}
        </h1>
        <Badge v-if="collection" variant="secondary" class="uppercase">
          {{ collection.type }}
        </Badge>
        <Badge
          v-else-if="collectionName === '_users'"
          variant="secondary"
          class="uppercase"
        >
          auth
        </Badge>
      </div>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          title="Refresh"
          @click="load(1, false)"
        >
          <RefreshCw class="h-4 w-4" />
        </Button>
        <Button v-if="!isView" data-action="new-record" @click="openNewRecord">
          <Plus class="h-4 w-4" />
          New Record
        </Button>
      </div>
    </div>

    <form class="mb-3 flex gap-2" @submit.prevent="applyFilter">
      <Input
        v-model="filterInput"
        placeholder="Filter, e.g. status = 'active' && age > 18"
        class="max-w-md font-mono text-xs"
      />
      <Button type="submit" variant="outline">Filter</Button>
      <Button
        v-if="route.query.filter"
        type="button"
        variant="ghost"
        @click="
          filterInput = '';
          applyFilter();
        "
      >
        Clear
      </Button>
    </form>

    <div v-if="loadError" class="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {{ loadError }}
    </div>

    <div class="min-h-0 flex-1 overflow-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead
              v-for="col in columns"
              :key="col"
              class="cursor-pointer select-none whitespace-nowrap"
              @click="toggleSort(col)"
            >
              <span class="inline-flex items-center gap-1">
                {{ col }}
                <ArrowUp v-if="sort === col && order === 'asc'" class="h-3 w-3" />
                <ArrowDown
                  v-else-if="sort === col && order === 'desc'"
                  class="h-3 w-3"
                />
                <ArrowUpDown v-else class="h-3 w-3 opacity-30" />
              </span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="(record, idx) in records"
            :key="String(record.id ?? idx)"
            class="cursor-pointer"
            @click="openEditRecord(record)"
          >
            <TableCell
              v-for="col in columns"
              :key="col"
              class="max-w-[24rem] whitespace-nowrap"
            >
              <template v-if="col === 'id'">
                <button
                  type="button"
                  :title="`${String(record[col])} — click to copy`"
                  class="inline-flex cursor-copy items-center gap-1 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] font-medium text-muted-foreground hover:border-primary/30 hover:bg-primary/10 hover:text-primary"
                  @click="copyId($event, record[col])"
                >
                  {{ shortId(record[col]) }}
                </button>
              </template>
              <template v-else>
                <span
                  v-if="formatCellValue(record[col], col).kind === 'empty'"
                  class="text-xs text-muted-foreground/50"
                  >—</span>
                <span
                  v-else-if="
                    formatCellValue(record[col], col).kind === 'boolean'
                  "
                  :class="[
                    'inline-flex items-center gap-1 rounded-full border px-2 py-px text-[0.7rem] font-semibold',
                    formatCellValue(record[col], col).bool
                      ? 'border-foreground/25 bg-foreground/10 text-foreground'
                      : 'border-border bg-muted text-muted-foreground',
                  ]"
                >
                  <span class="h-1.5 w-1.5 rounded-full bg-current" />
                  {{ formatCellValue(record[col], col).text }}
                </span>
                <span
                  v-else-if="formatCellValue(record[col], col).kind === 'date'"
                  class="flex flex-col gap-px"
                >
                  <span class="text-[0.8125rem]">{{
                    formatCellValue(record[col], col).date
                  }}</span>
                  <span class="text-[0.7rem] text-muted-foreground">{{
                    formatCellValue(record[col], col).time
                  }}</span>
                </span>
                <code
                  v-else-if="formatCellValue(record[col], col).kind === 'json'"
                  :title="formatCellValue(record[col], col).title"
                  class="inline-block max-w-[200px] truncate rounded border bg-muted px-1.5 py-px text-[0.7rem] text-muted-foreground"
                >
                  {{ formatCellValue(record[col], col).text }}
                </code>
                <span
                  v-else
                  :title="formatCellValue(record[col], col).title"
                  :class="[
                    'block truncate text-[0.8125rem]',
                    formatCellValue(record[col], col).kind === 'number'
                      ? 'tabular-nums'
                      : '',
                  ]"
                >
                  {{ formatCellValue(record[col], col).text }}
                </span>
              </template>
            </TableCell>
          </TableRow>
          <TableRow v-if="!loading && records.length === 0">
            <TableCell
              :colspan="Math.max(columns.length, 1)"
              class="py-10 text-center text-sm text-muted-foreground"
            >
              No records found.
            </TableCell>
          </TableRow>
          <TableRow v-if="loading">
            <TableCell
              :colspan="Math.max(columns.length, 1)"
              class="py-6 text-center text-sm text-muted-foreground"
            >
              Loading…
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <div v-if="hasMore" class="mt-3 flex justify-center">
      <Button
        variant="outline"
        :disabled="loading"
        @click="load(page + 1, true)"
      >
        Load more
      </Button>
    </div>

    <RecordFormSheet
      v-model:open="recordSheetOpen"
      :collection-name="collectionName"
      :record="editingRecord"
      @saved="onRecordSaved"
    />
  </div>
</template>
