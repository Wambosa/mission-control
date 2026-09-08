import { randomBytes } from "node:crypto";
import {
  deleteAppSetting,
  getAppSetting,
  setAppSetting,
} from "../repositories/app-settings.repo";
import { safeJsonParse } from "~/shared/safe-json";
import { logServerEvent, settingValueForLog } from "../log-event";

/**
 * Report a setting mutation with the key and both values.
 *
 * These three writers are the single choke point every settings mutation
 * passes through. The HTTP controller's update path is a long run of
 * independent field branches that never read a prior value, so instrumenting
 * there would give the key and the new value and nothing to compare it against
 * — while every one of those branches, and the recall-settings batch writer
 * that reads like a separate path, ends up here with the getter already in
 * scope.
 *
 * Nothing fires for a write that changes nothing: saving a settings page
 * re-sends every field it owns, so an unchanged-value event would turn one
 * click into a dozen lines and put the noise back that this work removed.
 */
function logSettingChange(key: string, previous: string | null, next: string | null): void {
  if (previous === next) return;
  logServerEvent("setting.changed", {
    key,
    from: settingValueForLog(key, previous),
    to: settingValueForLog(key, next),
  });
}

export function getSetting(key: string): string | null {
  return getAppSetting(key);
}

export function setSetting(key: string, value: string): void {
  const previous = getAppSetting(key);
  setAppSetting(key, value);
  logSettingChange(key, previous, value);
}

export function deleteSetting(key: string): void {
  const previous = getAppSetting(key);
  deleteAppSetting(key);
  logSettingChange(key, previous, null);
}

export function getBooleanSetting(key: string, defaultValue = false): boolean {
  const value = getAppSetting(key);
  if (value === null) return defaultValue;
  return value === "true";
}

export function setBooleanSetting(key: string, value: boolean): void {
  const previous = getAppSetting(key);
  const next = value ? "true" : "false";
  setAppSetting(key, next);
  logSettingChange(key, previous, next);
}

export function readJsonSetting<T>(key: string): T | null {
  return safeJsonParse<T | null>(getAppSetting(key), null);
}

const API_TOKEN_KEY = "api_token";
const AUTH_SECRET_KEY = "auth_secret";

/*
 * The two functions below write the repository directly rather than going
 * through setSetting, so no setting.changed event is emitted for them. That is
 * deliberate twice over: the value is a live credential and the diagnostics
 * export ships unscrubbed, and a first-boot token mint is not a user action
 * anyone is diagnosing. Should either ever be routed through setSetting, the
 * key-based redaction in log-event.ts keeps the value out of the log anyway.
 */
export function getOrCreateApiToken(): string {
  let token = getAppSetting(API_TOKEN_KEY);
  if (!token) {
    token = randomBytes(32).toString("hex");
    setAppSetting(API_TOKEN_KEY, token);
  }
  return token;
}

export function getOrCreateAuthSecret(): string {
  let secret = getAppSetting(AUTH_SECRET_KEY);
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    setAppSetting(AUTH_SECRET_KEY, secret);
  }
  return secret;
}

const SKILLS_INITIALIZED_AT_KEY = "skills_initialized_at";

export function getSkillsInitializedAt(): string | null {
  return getAppSetting(SKILLS_INITIALIZED_AT_KEY);
}

export function setSkillsInitializedAt(iso: string): void {
  setAppSetting(SKILLS_INITIALIZED_AT_KEY, iso);
}
