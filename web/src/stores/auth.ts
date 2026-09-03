import { defineStore } from "pinia";
import { api } from "@/lib/api";

export interface AdminUser {
  id: string;
  email: string;
  type: "admin";
}

export const useAuthStore = defineStore("auth", {
  state: () => ({
    user: null as AdminUser | null,
    bootstrapped: false,
  }),
  actions: {
    async fetchMe(): Promise<AdminUser | null> {
      try {
        this.user = await api.get<AdminUser>("/internal/api/auth/me");
      } catch {
        this.user = null;
      } finally {
        this.bootstrapped = true;
      }
      return this.user;
    },
    async login(email: string, password: string): Promise<AdminUser> {
      this.user = await api.post<AdminUser>("/internal/api/auth/login", {
        email,
        password,
      });
      this.bootstrapped = true;
      return this.user;
    },
    async logout(): Promise<void> {
      try {
        await api.post("/internal/api/auth/logout");
      } finally {
        this.user = null;
      }
    },
  },
});
