{{/*
Backend environment variables — used by every container in the backend pod: the
`migrate` and `bootstrap` init containers and the app container itself.

All of them read the RUNTIME Secret (visiban.secretName). Until #1117 there was
a second, hook-managed "bootstrap" copy of that Secret, because migrations ran in
a Helm pre-upgrade hook Job and Helm reconciles a plain Secret only after hooks
complete — so the Job would otherwise have read the previous revision's values.
Migrations now run as an init container in the backend pod, which Helm creates
long after it has applied the Secret, so the one runtime Secret is the only
source and there is nothing left to keep in sync.

Invocation: {{ include "visiban.backendEnv" . }}
*/}}
{{- define "visiban.backendEnv" -}}
{{- $ctx := . -}}
{{- $secret := include "visiban.secretName" . -}}
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
  {{- /*
  The bundled Valkey is deployed via the bitnami/valkey subchart, which names
  its own resources off $.Release.Name directly (release-valkey-primary) —
  NOT off visiban.fullname (release-visiban), which is this chart's own
  naming convention for ITS OWN templates. Using visiban.fullname here
  pointed at a Service that never existed, so the backend could never reach
  Redis: the readiness probe failed forever and `helm upgrade --wait` timed
  out on every install with valkey.enabled=true (#1116 deploy-testing gap).
  */}}
  value: {{ if $ctx.Values.valkey.enabled }}{{ printf "redis://%s-valkey-primary:6379/0" $ctx.Release.Name | quote }}{{ else }}{{ $ctx.Values.externalRedis.url | quote }}{{ end }}
- name: REDIS_CACHE_URL
  value: {{ if $ctx.Values.valkey.enabled }}{{ printf "redis://%s-valkey-primary:6379/1" $ctx.Release.Name | quote }}{{ else }}{{ $ctx.Values.externalRedis.cacheUrl | quote }}{{ end }}
{{- /*
  EMAIL_BACKEND is emitted ONLY when explicitly configured. Setting it pins the
  backend and suppresses the DB-backed configuration in Admin → Settings → Email
  (#306) — so emitting it unconditionally, as this chart did before 1.2, made
  that feature permanently inert on every Kubernetes install and left no way to
  install-then-configure. Leave backend.email.backend empty to keep the admin UI
  usable; set it to pin a specific backend on purpose.
*/}}
{{- if $ctx.Values.backend.email.backend }}
- name: EMAIL_BACKEND
  value: {{ printf "django.core.mail.backends.%s.EmailBackend" $ctx.Values.backend.email.backend | quote }}
{{- end }}
- name: EMAIL_HOST
  value: {{ $ctx.Values.backend.email.host | quote }}
- name: EMAIL_PORT
  value: {{ $ctx.Values.backend.email.port | quote }}
- name: EMAIL_HOST_USER
  value: {{ $ctx.Values.backend.email.user | quote }}
- name: EMAIL_USE_TLS
  value: {{ $ctx.Values.backend.email.useTls | quote }}
- name: EMAIL_USE_SSL
  value: {{ $ctx.Values.backend.email.useSsl | quote }}
- name: DEFAULT_FROM_EMAIL
  value: {{ $ctx.Values.backend.email.fromAddress | quote }}
- name: EMAIL_VERIFICATION
  value: {{ $ctx.Values.backend.settings.emailVerification | quote }}
- name: MAX_UPLOAD_SIZE_BYTES
  {{- /*
  int64 before quote is load-bearing: sprig's `quote` coerces through float64,
  so a bare `| quote` renders 10485760 as "1.048576e+07" — which Django's
  env.int() cannot parse, crash-looping the pod on a value that looks fine in
  values.yaml. Caught by scripts/helm-structure-check.sh section 6.
  */}}
  value: {{ $ctx.Values.backend.settings.maxUploadSizeBytes | int64 | quote }}
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
