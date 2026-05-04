{{/*
Backend environment variables — shared by the backend Deployment and the
pre-upgrade migrate Job. The Deployment reads from the runtime Secret
(visiban.secretName); the migrate Job reads from the bootstrap hook Secret
(visiban.bootstrapSecretName) so it picks up secret rotations applied in the
same `helm upgrade` invocation.

Default invocation (Deployment): {{ include "visiban.backendEnv" . }}
Migrate Job: {{ include "visiban.backendEnvWithSecret" (dict "ctx" . "secretName" (include "visiban.bootstrapSecretName" .)) }}
*/}}
{{- define "visiban.backendEnv" -}}
{{- include "visiban.backendEnvWithSecret" (dict "ctx" . "secretName" (include "visiban.secretName" .)) -}}
{{- end }}

{{- define "visiban.backendEnvWithSecret" -}}
{{- $ctx := .ctx -}}
{{- $secret := .secretName -}}
- name: DJANGO_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: django-secret-key
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: database-url
- name: DEBUG
  value: {{ $ctx.Values.backend.settings.debug | quote }}
- name: ALLOWED_HOSTS
  value: {{ printf "%s,127.0.0.1,localhost" $ctx.Values.backend.settings.allowedHosts | quote }}
- name: CORS_ALLOWED_ORIGINS
  value: {{ $ctx.Values.backend.settings.corsAllowedOrigins | quote }}
- name: FRONTEND_URL
  value: {{ $ctx.Values.backend.settings.frontendUrl | quote }}
- name: SITE_DOMAIN
  value: {{ $ctx.Values.backend.settings.siteDomain | quote }}
- name: APP_VERSION
  value: {{ $ctx.Chart.AppVersion | quote }}
- name: DJANGO_ADMIN_ALLOWED_IPS
  value: {{ $ctx.Values.backend.settings.adminAllowedIPs | quote }}
- name: USE_X_ACCEL_REDIRECT
  value: "false"
- name: REDIS_URL
  value: {{ if $ctx.Values.redis.enabled }}{{ printf "redis://%s-redis-master:6379/0" (include "visiban.fullname" $ctx) | quote }}{{ else }}{{ $ctx.Values.externalRedis.url | quote }}{{ end }}
- name: REDIS_CACHE_URL
  value: {{ if $ctx.Values.redis.enabled }}{{ printf "redis://%s-redis-master:6379/1" (include "visiban.fullname" $ctx) | quote }}{{ else }}{{ $ctx.Values.externalRedis.cacheUrl | quote }}{{ end }}
- name: EMAIL_BACKEND
  value: {{ printf "django.core.mail.backends.%s.EmailBackend" $ctx.Values.backend.email.backend | quote }}
- name: EMAIL_HOST
  value: {{ $ctx.Values.backend.email.host | quote }}
- name: EMAIL_PORT
  value: {{ $ctx.Values.backend.email.port | quote }}
- name: EMAIL_HOST_USER
  value: {{ $ctx.Values.backend.email.user | quote }}
- name: EMAIL_USE_TLS
  value: {{ $ctx.Values.backend.email.useTls | quote }}
- name: DEFAULT_FROM_EMAIL
  value: {{ $ctx.Values.backend.email.fromAddress | quote }}
- name: EMAIL_VERIFICATION
  value: {{ $ctx.Values.backend.settings.emailVerification | quote }}
{{- if eq $ctx.Values.backend.email.backend "smtp" }}
- name: EMAIL_HOST_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.emailSecretName" $ctx }}
      key: {{ $ctx.Values.backend.email.passwordKey | default "email-password" }}
{{- end }}
- name: GOOGLE_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: google-client-id
- name: GOOGLE_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: google-client-secret
- name: GITHUB_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: github-client-id
- name: GITHUB_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: github-client-secret
- name: GITLAB_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: gitlab-client-id
- name: GITLAB_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: gitlab-client-secret
{{- if $ctx.Values.backend.oauth.oidc.serverUrl }}
- name: OIDC_SERVER_URL
  value: {{ $ctx.Values.backend.oauth.oidc.serverUrl | quote }}
- name: OIDC_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: oidc-client-id
- name: OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: oidc-client-secret
- name: OIDC_PROVIDER_NAME
  value: {{ $ctx.Values.backend.oauth.oidc.providerName | quote }}
{{- end }}
{{- if $ctx.Values.backend.settings.forceInsecureCookies }}
- name: FORCE_INSECURE_COOKIES
  value: "true"
{{- end }}
{{- end }}
