{{/*
Backend environment variables — shared by the init container and main container.
*/}}
{{- define "visiban.backendEnv" -}}
- name: DJANGO_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: django-secret-key
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: database-url
- name: DEBUG
  value: {{ .Values.backend.settings.debug | quote }}
- name: ALLOWED_HOSTS
  value: {{ printf "%s,127.0.0.1,localhost" .Values.backend.settings.allowedHosts | quote }}
- name: CORS_ALLOWED_ORIGINS
  value: {{ .Values.backend.settings.corsAllowedOrigins | quote }}
- name: FRONTEND_URL
  value: {{ .Values.backend.settings.frontendUrl | quote }}
- name: SITE_DOMAIN
  value: {{ .Values.backend.settings.siteDomain | quote }}
- name: REDIS_URL
  value: {{ if .Values.redis.enabled }}{{ printf "redis://%s-redis-master:6379/0" (include "visiban.fullname" .) | quote }}{{ else }}{{ .Values.externalRedis.url | quote }}{{ end }}
- name: REDIS_CACHE_URL
  value: {{ if .Values.redis.enabled }}{{ printf "redis://%s-redis-master:6379/1" (include "visiban.fullname" .) | quote }}{{ else }}{{ .Values.externalRedis.cacheUrl | quote }}{{ end }}
- name: GOOGLE_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: google-client-id
- name: GOOGLE_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: google-client-secret
- name: GITHUB_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: github-client-id
- name: GITHUB_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: github-client-secret
- name: GITLAB_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: gitlab-client-id
- name: GITLAB_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: gitlab-client-secret
{{- if .Values.backend.oauth.oidc.serverUrl }}
- name: OIDC_SERVER_URL
  value: {{ .Values.backend.oauth.oidc.serverUrl | quote }}
- name: OIDC_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: oidc-client-id
- name: OIDC_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.secretName" . }}
      key: oidc-client-secret
- name: OIDC_PROVIDER_NAME
  value: {{ .Values.backend.oauth.oidc.providerName | quote }}
{{- end }}
{{- end }}
