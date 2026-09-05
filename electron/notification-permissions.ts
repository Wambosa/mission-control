export const NOTIFICATION_WEB_PERMISSION = "notifications";

// Notifications are the only web permission this app asks for. Everything else
// — media (mic/camera/display), geolocation, midi — is denied outright.
export function shouldAllowWebPermission(permission: string): boolean {
  return permission === NOTIFICATION_WEB_PERMISSION;
}
