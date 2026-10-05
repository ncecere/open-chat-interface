{{/* Names */}}
{{- define "oci.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "oci.fullname" -}}
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

{{/* Component names, kept short enough for the longest suffix. */}}
{{- define "oci.componentName" -}}
{{- printf "%s-%s" (include "oci.fullname" .root | trunc 45 | trimSuffix "-") .component -}}
{{- end -}}
{{- define "oci.api.name" -}}{{ include "oci.componentName" (dict "root" . "component" "api") }}{{- end -}}
{{- define "oci.apiHeadless.name" -}}{{ include "oci.componentName" (dict "root" . "component" "api-headless") }}{{- end -}}
{{- define "oci.worker.name" -}}{{ include "oci.componentName" (dict "root" . "component" "worker") }}{{- end -}}
{{- define "oci.web.name" -}}{{ include "oci.componentName" (dict "root" . "component" "web") }}{{- end -}}
{{- define "oci.migrate.name" -}}{{ include "oci.componentName" (dict "root" . "component" "migrate") }}{{- end -}}
{{- define "oci.migratePost.name" -}}{{ include "oci.componentName" (dict "root" . "component" "migrate-post") }}{{- end -}}

{{- define "oci.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels */}}
{{- define "oci.selectorLabels" -}}
app.kubernetes.io/name: {{ include "oci.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "oci.labels" -}}
helm.sh/chart: {{ include "oci.chart" .root }}
{{ include "oci.selectorLabels" . }}
app.kubernetes.io/version: {{ include "oci.imageTag" (dict "root" .root "image" .root.Values.image.api) | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/part-of: open-chat-interface
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{- end -}}

{{/* Images */}}
{{- define "oci.imageTag" -}}
{{- default .root.Chart.AppVersion .image.tag -}}
{{- end -}}

{{- define "oci.image" -}}
{{- $tag := include "oci.imageTag" . -}}
{{- if .image.digest -}}
{{- printf "%s:%s@%s" .image.repository $tag .image.digest -}}
{{- else -}}
{{- printf "%s:%s" .image.repository $tag -}}
{{- end -}}
{{- end -}}

{{- define "oci.pullSecrets" -}}
{{- with .Values.image.pullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "oci.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "oci.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The Secret every API, worker and migration pod reads. */}}
{{- define "oci.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "oci.componentName" (dict "root" . "component" "runtime") -}}
{{- end -}}
{{- end -}}

{{/* The API's role: web when a separate worker runs the jobs. */}}
{{- define "oci.apiRole" -}}
{{- if .Values.worker.enabled -}}web{{- else -}}all{{- end -}}
{{- end -}}

{{/*
Environment shared by the API, worker and migration pods. Plain configuration
is inline (so the pre-install migration hook needs no release resource); the
Secret arrives through envFrom.
*/}}
{{- define "oci.env" -}}
{{- $root := .root -}}
{{- $c := $root.Values.config -}}
- name: NODE_ENV
  value: production
- name: API_PORT
  value: "3000"
- name: APP_URL
  value: {{ $c.appUrl | quote }}
{{- with $c.authTrustedOrigins }}
- name: AUTH_TRUSTED_ORIGINS
  value: {{ . | quote }}
{{- end }}
- name: LOG_LEVEL
  value: {{ $c.logLevel | quote }}
- name: STORAGE_LOCAL_PATH
  value: {{ $c.storageLocalPath | quote }}
- name: SHUTDOWN_DRAIN_TIMEOUT_MS
  value: {{ $c.shutdownDrainTimeoutMs | toString | quote }}
{{- with $c.migrationLockTimeoutMs | toString }}
- name: MIGRATION_LOCK_TIMEOUT_MS
  value: {{ . | quote }}
{{- end }}
{{- with $c.migrationStatementTimeoutMs | toString }}
- name: MIGRATION_STATEMENT_TIMEOUT_MS
  value: {{ . | quote }}
{{- end }}
{{- with $c.postMigrationStatementTimeoutMs | toString }}
- name: POST_MIGRATION_STATEMENT_TIMEOUT_MS
  value: {{ . | quote }}
{{- end }}
{{- with $c.otelExporterOtlpEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ . | quote }}
{{- end }}
{{- with $c.otelServiceName }}
- name: OTEL_SERVICE_NAME
  value: {{ . | quote }}
{{- end }}
{{- with $root.Values.redis.sentinels }}
- name: REDIS_SENTINELS
  value: {{ . | quote }}
{{- end }}
{{- with $root.Values.redis.clusterNodes }}
- name: REDIS_CLUSTER_NODES
  value: {{ . | quote }}
{{- end }}
{{- if $root.Values.migrations.enabled }}
# The migration hooks own schema changes; replicas only check the schema.
- name: RUN_MIGRATIONS
  value: "false"
- name: RUN_POST_MIGRATIONS
  value: "false"
{{- else if eq .component "worker" }}
- name: RUN_MIGRATIONS
  value: "false"
{{- end }}
{{- range $name, $value := $c.env }}
- name: {{ $name }}
  value: {{ $value | toString | quote }}
{{- end }}
- name: OCI_ROLE
  value: {{ .role | quote }}
{{- with $root.Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "oci.envFrom" -}}
- secretRef:
    name: {{ include "oci.secretName" . }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* preStop: a short sleep before SIGTERM, so routing catches up. */}}
{{- define "oci.preStop" -}}
{{- if gt (int .seconds) 0 }}
lifecycle:
  preStop:
    {{- if .native }}
    sleep:
      seconds: {{ int .seconds }}
    {{- else }}
    exec:
      command: ["sleep", "{{ int .seconds }}"]
    {{- end }}
{{- end }}
{{- end -}}

{{/* Default topology spread: nodes, then zones, both best effort. */}}
{{- define "oci.topologySpread" -}}
{{- $v := .values -}}
{{- if $v.topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml $v.topologySpreadConstraints | nindent 2 }}
{{- else if $v.defaultTopologySpread }}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "oci.selectorLabels" (dict "root" .root "component" .component) | nindent 8 }}
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "oci.selectorLabels" (dict "root" .root "component" .component) | nindent 8 }}
{{- end }}
{{- end -}}

{{/* Scheduling fields shared by every Deployment. */}}
{{- define "oci.scheduling" -}}
{{- with .values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .values.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with .values.priorityClassName }}
priorityClassName: {{ . }}
{{- end }}
{{- include "oci.topologySpread" . }}
{{- end -}}

{{/* Volumes for the API image: storage and /tmp. */}}
{{- define "oci.apiVolumes" -}}
- name: tmp
  emptyDir:
    sizeLimit: {{ .Values.tmpVolume.sizeLimit }}
- name: storage
{{- if .Values.storage.persistence.enabled }}
  persistentVolumeClaim:
    claimName: {{ default (include "oci.componentName" (dict "root" . "component" "storage")) .Values.storage.persistence.existingClaim }}
{{- else }}
  emptyDir:
    sizeLimit: {{ .Values.storage.emptyDirSizeLimit }}
{{- end }}
{{- end -}}

{{- define "oci.apiVolumeMounts" -}}
- name: tmp
  mountPath: /tmp
- name: storage
  mountPath: {{ .Values.config.storageLocalPath }}
{{- end -}}

{{/*
Validation. Called from every workload template so a bad configuration fails
at render time, not at rollout.
*/}}
{{- define "oci.validate" -}}
{{- $v := .Values -}}
{{- if not $v.config.appUrl -}}
{{- fail "config.appUrl is required: the public URL people use (for example https://chat.example.com)" -}}
{{- end -}}
{{- if not $v.secrets.existingSecret -}}
{{- range $key := list "DATABASE_URL" "AUTH_SECRET" "ENCRYPTION_KEY" -}}
{{- if not (index $v.secrets.values $key) -}}
{{- fail (printf "Set secrets.existingSecret (recommended), or secrets.values.%s for an evaluation install" $key) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $drainSeconds := divf (float64 $v.config.shutdownDrainTimeoutMs) 1000.0 -}}
{{- if le (float64 $v.api.terminationGracePeriodSeconds) (addf $drainSeconds (float64 $v.api.preStopSleepSeconds)) -}}
{{- fail (printf "api.terminationGracePeriodSeconds (%v) must exceed config.shutdownDrainTimeoutMs/1000 + api.preStopSleepSeconds (%v), with a few seconds for the final saves" $v.api.terminationGracePeriodSeconds (addf $drainSeconds (float64 $v.api.preStopSleepSeconds))) -}}
{{- end -}}
{{- if and $v.worker.enabled (le (float64 $v.worker.terminationGracePeriodSeconds) $drainSeconds) -}}
{{- fail (printf "worker.terminationGracePeriodSeconds (%v) must exceed config.shutdownDrainTimeoutMs/1000 (%v)" $v.worker.terminationGracePeriodSeconds $drainSeconds) -}}
{{- end -}}
{{- range $name := list "api" "worker" "web" -}}
{{- $w := index $v $name -}}
{{- if and $w.strategy (eq (toString $w.strategy.type) "RollingUpdate") $w.strategy.rollingUpdate -}}
{{- if not (has (toString $w.strategy.rollingUpdate.maxUnavailable) (list "0" "0%")) -}}
{{- fail (printf "%s.strategy.rollingUpdate.maxUnavailable must be 0: a replacement must be ready before a replica drains" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and (not $v.migrations.enabled) (or (gt (int $v.api.replicaCount) 1) $v.api.autoscaling.enabled) -}}
{{- fail "migrations.enabled=false makes the API migrate itself at startup, which suits one replica only: set api.replicaCount to 1 or enable the migration hooks" -}}
{{- end -}}
{{- end -}}
