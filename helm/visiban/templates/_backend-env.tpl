{{/*
Backend environment variables — shared by the init container and main container.
*/}}
{{- define "visiban.backendEnv" -}}
- name: DJANGO_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.fullname" . }}
      key: django-secret-key
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.fullname" . }}
      key: database-url
- name: DEBUG
  value: {{ .Values.backend.settings.debug | quote }}
- name: ALLOWED_HOSTS
  value: {{ .Values.backend.settings.allowedHosts | quote }}
- name: CORS_ALLOWED_ORIGINS
  value: {{ .Values.backend.settings.corsAllowedOrigins | quote }}
- name: GOOGLE_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.fullname" . }}
      key: google-client-id
- name: GOOGLE_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.fullname" . }}
      key: google-client-secret
- name: GITHUB_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.fullname" . }}
      key: github-client-id
- name: GITHUB_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.fullname" . }}
      key: github-client-secret
- name: GITLAB_CLIENT_ID
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.fullname" . }}
      key: gitlab-client-id
- name: GITLAB_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "visiban.fullname" . }}
      key: gitlab-client-secret
{{- end }}
