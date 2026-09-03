<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Braces,
  Database,
  Eye,
  FlaskConical,
  LogOut,
  Moon,
  Plus,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Table2,
  TerminalSquare,
  Users,
} from "lucide-vue-next";
import { toast } from "vue-sonner";
import { useAuthStore } from "@/stores/auth";
import { useCollectionsStore } from "@/stores/collections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import NewCollectionSheet from "@/components/collections/NewCollectionSheet.vue";
import CollectionSettingsSheet from "@/components/collections/CollectionSettingsSheet.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useCollectionsStore();

const isDark = ref(document.documentElement.classList.contains("dark"));

function toggleTheme() {
  isDark.value = !isDark.value;
  document.documentElement.classList.toggle("dark", isDark.value);
  try {
    localStorage.setItem("grescale-theme", isDark.value ? "dark" : "light");
  } catch {}
}

async function onLogout() {
  await auth.logout();
  toast.success("Signed out.");
  router.push("/login");
}

const navItems = [
  { to: "/collections", icon: Database, title: "Collections" },
  { to: "/collections/_users", icon: ShieldCheck, title: "Superadmins" },
  { to: "/logs", icon: ScrollText, title: "Logs" },
  { to: "/api-tester", icon: FlaskConical, title: "API Tester" },
  { to: "/sql-explorer", icon: TerminalSquare, title: "SQL Explorer" },
  { to: "/custom-endpoints", icon: Braces, title: "Custom Endpoints" },
];

function navActive(to: string) {
  if (to === "/collections") {
    return (
      route.path === "/collections" ||
      (route.path.startsWith("/collections/") &&
        route.path !== "/collections/_users")
    );
  }
  return route.path === to || route.path.startsWith(`${to}/`);
}

const showCollectionsPanel = computed(
  () =>
    route.path === "/collections" ||
    (route.path.startsWith("/collections/") &&
      route.path !== "/collections/_users"),
);

const newCollectionOpen = ref(false);
const settingsFor = ref<string | null>(null);

watch(
  () => route.params.name,
  (name) => {
    store.setCurrent(typeof name === "string" ? name : null);
  },
  { immediate: true },
);

const searchInput = ref("");
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(searchInput, (value) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    store.search = value;
  }, 200);
});

store.fetchAll();

function typeIcon(type: string) {
  if (type === "auth") return Users;
  if (type === "view") return Eye;
  return Table2;
}
</script>

<template>
  <div class="flex h-screen bg-background text-foreground">
    <!-- Icon rail -->
    <nav
      class="flex w-14 flex-col items-center gap-1 border-r bg-card py-3"
      aria-label="Primary"
    >
      <img
        src="/logo.png"
        alt="Grescale"
        class="mb-3 h-9 w-9 rounded-lg"
      />

      <Button
        v-for="item in navItems"
        :key="item.to"
        variant="ghost"
        size="icon"
        :title="item.title"
        :class="navActive(item.to) ? 'bg-accent text-accent-foreground' : ''"
        @click="router.push(item.to)"
      >
        <component :is="item.icon" />
      </Button>

      <div class="mt-auto flex flex-col gap-1">
        <Button
          variant="ghost"
          size="icon"
          title="Toggle theme"
          @click="toggleTheme"
        >
          <Sun v-if="isDark" />
          <Moon v-else />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="Settings"
          :class="navActive('/settings') ? 'bg-accent text-accent-foreground' : ''"
          @click="router.push('/settings')"
        >
          <Settings />
        </Button>
        <Button variant="ghost" size="icon" title="Sign out" @click="onLogout">
          <LogOut />
        </Button>
      </div>
    </nav>

    <!-- Collections panel -->
    <aside
      v-if="showCollectionsPanel"
      class="flex w-60 flex-col border-r bg-card/50"
    >
      <div class="flex items-center justify-between px-4 pb-2 pt-4">
        <h2 class="text-sm font-semibold tracking-tight">Collections</h2>
        <Button
          variant="ghost"
          size="icon"
          class="h-7 w-7"
          title="New collection"
          @click="newCollectionOpen = true"
        >
          <Plus class="h-4 w-4" />
        </Button>
      </div>
      <div class="px-3 pb-2">
        <div class="relative">
          <Search
            class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            v-model="searchInput"
            placeholder="Search collections..."
            class="h-8 pl-8 text-xs"
          />
        </div>
      </div>
      <div class="flex-1 overflow-y-auto px-2 pb-3">
        <p
          v-if="store.loaded && store.filtered.length === 0"
          class="px-2 py-4 text-xs text-muted-foreground"
        >
          No collections found.
        </p>
        <div
          v-for="col in store.filtered"
          :key="col.name"
          role="button"
          tabindex="0"
          :data-collection="col.name"
          :class="[
            'group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60',
            store.currentName === col.name
              ? 'bg-accent font-medium text-accent-foreground'
              : 'text-foreground/80',
          ]"
          @click="router.push(`/collections/${col.name}`)"
          @keydown.enter="router.push(`/collections/${col.name}`)"
        >
          <component
            :is="typeIcon(col.type)"
            class="h-4 w-4 shrink-0 text-muted-foreground"
          />
          <span class="min-w-0 flex-1 truncate">{{ col.name }}</span>
          <button
            type="button"
            title="Collection settings"
            :data-settings-for="col.name"
            class="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
            @click.stop="settingsFor = col.name"
          >
            <Settings class="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>

    <!-- Main area -->
    <main class="min-w-0 flex-1 overflow-y-auto">
      <RouterView />
    </main>

    <NewCollectionSheet v-model:open="newCollectionOpen" />
    <CollectionSettingsSheet
      :collection-name="settingsFor"
      @update:collection-name="settingsFor = $event"
    />
  </div>
</template>
