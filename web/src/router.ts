import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import LoginPage from "@/pages/LoginPage.vue";
import SetupPage from "@/pages/SetupPage.vue";
import SetupDbPage from "@/pages/SetupDbPage.vue";
import CollectionsPage from "@/pages/CollectionsPage.vue";
import CollectionRecordsPage from "@/pages/CollectionRecordsPage.vue";
import LogsPage from "@/pages/LogsPage.vue";
import ApiTesterPage from "@/pages/ApiTesterPage.vue";
import SqlExplorerPage from "@/pages/SqlExplorerPage.vue";
import CustomEndpointsPage from "@/pages/CustomEndpointsPage.vue";
import SettingsPage from "@/pages/SettingsPage.vue";
import AppShell from "@/AppShell.vue";

const PUBLIC_PATHS = new Set(["/login", "/setup", "/setup-db"]);

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginPage },
    { path: "/setup", name: "setup", component: SetupPage },
    { path: "/setup-db", name: "setup-db", component: SetupDbPage },
    {
      path: "/",
      component: AppShell,
      children: [
        { path: "", redirect: "/collections" },
        { path: "collections", name: "collections", component: CollectionsPage },
        {
          path: "collections/:name",
          name: "collection-records",
          component: CollectionRecordsPage,
        },
        { path: "logs", name: "logs", component: LogsPage },
        { path: "api-tester", name: "api-tester", component: ApiTesterPage },
        {
          path: "sql-explorer",
          name: "sql-explorer",
          component: SqlExplorerPage,
        },
        {
          path: "custom-endpoints",
          name: "custom-endpoints",
          component: CustomEndpointsPage,
        },
        { path: "settings", name: "settings", component: SettingsPage },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/collections" },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();

  if (!auth.bootstrapped) {
    await auth.fetchMe();
  }

  if (PUBLIC_PATHS.has(to.path)) {
    if (to.path === "/login" && auth.user) {
      return { path: "/" };
    }
    return true;
  }

  if (!auth.user) {
    return { path: "/login", query: to.fullPath !== "/" ? { redirect: to.fullPath } : {} };
  }

  return true;
});
