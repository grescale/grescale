import { defineStore } from "pinia";
import { api } from "@/lib/api";

export interface FieldDef {
  name: string;
  type: string;
  required?: boolean;
  system?: boolean;
  unique?: boolean;
  min?: number | null;
  max?: number | null;
  regex?: string | null;
  trim_input?: boolean;
  nonzero?: boolean;
  date_format?: string;
  relation_collection?: string | null;
  isNew?: boolean;
  originalName?: string;
}

export interface CollectionMeta {
  name: string;
  type: "base" | "auth" | "view";
  schema: FieldDef[];
  oauth2: { auth_method?: string; google_enabled?: boolean } | null;
  view_query: string | null;
  list_rule: string | null;
  view_rule: string | null;
  create_rule: string | null;
  update_rule: string | null;
  delete_rule: string | null;
}

export const useCollectionsStore = defineStore("collections", {
  state: () => ({
    collections: [] as CollectionMeta[],
    loaded: false,
    loading: false,
    search: "",
    currentName: null as string | null,
  }),
  getters: {
    filtered(state): CollectionMeta[] {
      const term = state.search.trim().toLowerCase();
      if (!term) return state.collections;
      return state.collections.filter((c) =>
        c.name.toLowerCase().includes(term),
      );
    },
    current(state): CollectionMeta | null {
      return (
        state.collections.find((c) => c.name === state.currentName) ?? null
      );
    },
  },
  actions: {
    async fetchAll(force = false) {
      if (this.loaded && !force) return;
      this.loading = true;
      try {
        const data = await api.get<{ collections: CollectionMeta[] }>(
          "/internal/api/admin/collections",
        );
        this.collections = data.collections;
        this.loaded = true;
      } finally {
        this.loading = false;
      }
    },
    async refresh() {
      await this.fetchAll(true);
    },
    setCurrent(name: string | null) {
      this.currentName = name;
    },
  },
});
