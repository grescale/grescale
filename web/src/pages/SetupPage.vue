<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { Loader2 } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api, ApiError } from "@/lib/api";

const router = useRouter();

const email = ref("");
const password = ref("");
const setupToken = ref("");
const error = ref("");
const loading = ref(false);

async function onSubmit() {
  error.value = "";
  loading.value = true;
  try {
    const data = await api.post<{ success: boolean }>(
      "/internal/api/auth/setup",
      {
        email: email.value,
        password: password.value,
        setup_token: setupToken.value,
      },
    );
    if (data?.success) {
      toast.success("Admin account created. You can sign in now.");
      router.push("/login");
      return;
    }
    error.value = "Setup failed.";
  } catch (err) {
    error.value =
      err instanceof ApiError ? err.message : "An unexpected error occurred.";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center gap-7 p-4">
    <div class="flex flex-col items-center gap-3 text-center">
      <img
        src="/logo.png"
        alt="Grescale"
        class="h-11 w-11 rounded-lg shadow-md"
      />
      <div>
        <div class="text-2xl font-semibold tracking-tight">Grescale</div>
        <div class="text-sm text-muted-foreground">
          Create your first admin account
        </div>
      </div>
    </div>

    <Card class="w-full max-w-[420px]">
      <CardHeader>
        <CardTitle>Initial setup</CardTitle>
        <CardDescription
          >This instance has no admin yet. Create one to continue.</CardDescription
        >
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-4" @submit.prevent="onSubmit">
          <div class="flex flex-col gap-2">
            <Label for="setup-email">Admin Email</Label>
            <Input
              id="setup-email"
              v-model="email"
              type="email"
              required
              autocomplete="email"
              placeholder="admin@example.com"
            />
          </div>
          <div class="flex flex-col gap-2">
            <Label for="setup-password">Password</Label>
            <Input
              id="setup-password"
              v-model="password"
              type="password"
              minlength="8"
              required
              autocomplete="new-password"
              placeholder="••••••••"
            />
            <p class="text-xs text-muted-foreground">Minimum 8 characters.</p>
          </div>
          <div class="flex flex-col gap-2">
            <Label for="setup-token">Setup Token</Label>
            <Input
              id="setup-token"
              v-model="setupToken"
              type="password"
              required
              autocomplete="off"
              placeholder="••••••••••••"
            />
            <p class="text-xs text-muted-foreground">
              Printed in the server log at first boot, or set via the
              <code class="rounded bg-muted px-1 py-0.5">SETUP_TOKEN</code>
              environment variable.
            </p>
          </div>

          <p v-if="error" class="text-sm font-medium text-destructive">
            {{ error }}
          </p>

          <Button type="submit" class="mt-2 h-11 w-full" :disabled="loading">
            <Loader2 v-if="loading" class="animate-spin" />
            Create Admin Account
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
