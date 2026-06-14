{{- define "airbarium-api.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "airbarium-api.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "airbarium-api.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "airbarium-api.selectorLabels" -}}
app.kubernetes.io/name: {{ include "airbarium-api.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "airbarium-api.labels" -}}
helm.sh/chart: {{ include "airbarium-api.chart" . }}
{{ include "airbarium-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "airbarium-api.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "airbarium-api.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "airbarium-api.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/* Runtime Secret name: existing one if provided, else the chart fullname */}}
{{- define "airbarium-api.secretName" -}}
{{- if .Values.secret.existingSecret -}}
{{- .Values.secret.existingSecret -}}
{{- else -}}
{{- include "airbarium-api.fullname" . -}}
{{- end -}}
{{- end -}}

{{/* Non-sensitive env, shared by the runtime ConfigMap and the migration hook ConfigMap.
     PUSHGATEWAY_URL is emitted ONLY when non-empty: config/env.ts validates it as
     z.string().url().optional(), so an empty string would fail validation and crash boot. */}}
{{- define "airbarium-api.configData" -}}
NODE_ENV: {{ .Values.config.NODE_ENV | quote }}
PORT: {{ .Values.config.PORT | quote }}
LOG_LEVEL: {{ .Values.config.LOG_LEVEL | quote }}
BETTER_AUTH_URL: {{ .Values.config.BETTER_AUTH_URL | quote }}
APP_URL: {{ .Values.config.APP_URL | quote }}
MAIL_FROM: {{ .Values.config.MAIL_FROM | quote }}
GARAGE_ENDPOINT: {{ .Values.config.GARAGE_ENDPOINT | quote }}
GARAGE_REGION: {{ .Values.config.GARAGE_REGION | quote }}
WIKIPEDIA_USER_AGENT: {{ .Values.config.WIKIPEDIA_USER_AGENT | quote }}
{{- with .Values.config.PUSHGATEWAY_URL }}
PUSHGATEWAY_URL: {{ . | quote }}
{{- end }}
{{- end -}}

{{/* Sensitive env, shared by the runtime Secret and the migration hook Secret.
     required() guards force callers to pass these (e.g. via ci/values-ci.yaml or -f secrets.yaml). */}}
{{- define "airbarium-api.secretData" -}}
DATABASE_URL: {{ required "secret.data.DATABASE_URL is required when secret.create=true" .Values.secret.data.DATABASE_URL | quote }}
BETTER_AUTH_SECRET: {{ required "secret.data.BETTER_AUTH_SECRET is required when secret.create=true" .Values.secret.data.BETTER_AUTH_SECRET | quote }}
GARAGE_ACCESS_KEY: {{ required "secret.data.GARAGE_ACCESS_KEY is required when secret.create=true" .Values.secret.data.GARAGE_ACCESS_KEY | quote }}
GARAGE_SECRET_KEY: {{ required "secret.data.GARAGE_SECRET_KEY is required when secret.create=true" .Values.secret.data.GARAGE_SECRET_KEY | quote }}
PLANTNET_API_KEY: {{ required "secret.data.PLANTNET_API_KEY is required when secret.create=true" .Values.secret.data.PLANTNET_API_KEY | quote }}
SMTP_URL: {{ required "secret.data.SMTP_URL is required when secret.create=true" .Values.secret.data.SMTP_URL | quote }}
{{- end -}}
