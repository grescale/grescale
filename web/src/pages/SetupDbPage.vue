<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { Database, Loader2 } from "lucide-vue-next";
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

const router = useRouter();

const databaseUrl = ref("");
const setupToken = ref("");
const error = ref("");
const loading = ref(false);

async function onSubmit() {
  error.value = "";
  loading.value = true;
  try {
    // The /setup-db handler is form-encoded and always answers with a redirect
    // (success -> /setup, failure -> /setup-db?error=...), so inspect the final
    // URL after fetch follows the redirect.
    const res = await fetch("/setup-db", {
      method: "POST",
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        database_url: databaseUrl.value,
        setup_token: setupToken.value,
      }),
      credentials: "same-origin",
    });

    const finalUrl = new URL(res.url);
    const redirectError = finalUrl.searchParams.get("error");
    if (redirectError) {
      error.value = redirectError;
    } else if (finalUrl.pathname === "/setup") {
      toast.success("Database connected. Create your admin account next.");
      router.push("/setup");
    } else {
      error.value = "Setup failed. Check the database URL and try again.";
    }
  } catch {
    error.value = "An unexpected error occurred.";
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
        <div class="text-sm text-muted-foreground">Connect to Postgres</div>
      </div>
    </div>

    <Card class="w-full max-w-[420px]">
      <CardHeader>
        <CardTitle>Database setup</CardTitle>
        <CardDescription
          >Point Grescale at your Postgres database.</CardDescription
        >
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-4" @submit.prevent="onSubmit">
          <div class="flex flex-col gap-2">
            <Label for="database_url">Database URL</Label>
            <Input
              id="database_url"
              v-model="databaseUrl"
              type="text"
              required
              placeholder="postgres://user:pass@localhost:5432/grescale"
            />
          </div>
          <div class="flex flex-col gap-2">
            <Label for="setup_token">Setup Token</Label>
            <Input
              id="setup_token"
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
            <Database v-else />
            Connect &amp; Initialize
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
