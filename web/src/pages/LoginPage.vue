<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Loader2, LogIn } from "lucide-vue-next";
import { toast } from "vue-sonner";
import { useAuthStore } from "@/stores/auth";
import { ApiError } from "@/lib/api";
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
const route = useRoute();
const auth = useAuthStore();

const email = ref("");
const password = ref("");
const error = ref("");
const loading = ref(false);

async function onSubmit() {
  error.value = "";
  loading.value = true;
  try {
    await auth.login(email.value, password.value);
    toast.success("Signed in successfully.");
    const redirect =
      typeof route.query.redirect === "string" ? route.query.redirect : "/";
    router.push(redirect);
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
          Sign in to your admin account
        </div>
      </div>
    </div>

    <Card class="w-full max-w-[420px]">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription
          >Enter your admin credentials to continue.</CardDescription
        >
      </CardHeader>
      <CardContent>
        <form class="flex flex-col gap-4" @submit.prevent="onSubmit">
          <div class="flex flex-col gap-2">
            <Label for="login-email">Email</Label>
            <Input
              id="login-email"
              v-model="email"
              type="email"
              required
              autocomplete="email"
              placeholder="admin@example.com"
            />
          </div>
          <div class="flex flex-col gap-2">
            <Label for="login-password">Password</Label>
            <Input
              id="login-password"
              v-model="password"
              type="password"
              required
              autocomplete="current-password"
              placeholder="••••••••"
            />
          </div>

          <p v-if="error" class="text-sm font-medium text-destructive">
            {{ error }}
          </p>

          <Button type="submit" class="mt-2 h-11 w-full" :disabled="loading">
            <Loader2 v-if="loading" class="animate-spin" />
            <LogIn v-else />
            Sign in
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
