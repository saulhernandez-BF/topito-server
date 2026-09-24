# topito-server

Backend del plugin de Figma **topito-writer**. Es un servidor Express que recibe
texto desde el plugin y usa IA (Claude y, opcionalmente, Gemini) para corregir
ortografía, reescribir copy con el tono de marca, o generar copy nuevo —
siempre con ejemplos reales de Ben & Frank / Bombavista como referencia de
estilo. También guarda feedback del equipo (👍/⚪) para ir afinando esas
referencias con el tiempo, y expone un login con Google para que solo el
equipo (correos `@benandfrank.com`) pueda usarlo.

Vive desplegado en Render: `https://topito-server.onrender.com`.

## Cómo funciona, en corto

1. El plugin manda un texto + marca (`benandfrank`/`bombavista`) + formato
   (headline, primario, caption, web...) a uno de los endpoints de generación.
2. El server busca, entre los ejemplos de tono guardados en `data/<marca>/`,
   los más parecidos al texto pedido (por similitud de embeddings, con
   respaldo aleatorio si aún no hay embeddings calculados).
3. Arma un prompt con esos ejemplos como referencia de estilo y se lo manda a
   Claude (o Gemini, según el endpoint).
4. Devuelve el resultado al plugin.

Los ejemplos de tono se alimentan de dos fuentes: anuncios reales de Meta Ads
(`scripts/fetch-meta-ads.mjs`) y los textos generados que el equipo marca como
👍 desde el plugin (se guardan automáticamente). Un workflow de GitHub Actions
corre esto semanalmente (ver [Automatizaciones](#automatizaciones-github-actions)).

## Instalación y arranque local

Requiere Node 22+.

```bash
npm install
cp .env.example .env
# Edita .env y pon tu GOOGLE_API_KEY y ANTHROPIC_API_KEY (ver abajo)
npm run dev     # con recarga automática (nodemon)
# o
npm start       # sin recarga
```

El server arranca en `http://localhost:3000` (o el puerto que pongas en
`PORT`). `GOOGLE_API_KEY` y `ANTHROPIC_API_KEY` son obligatorias — el server no
arranca sin ellas.

## Variables de entorno

Ver `.env.example` para la lista completa con comentarios. Resumen:

| Variable | Obligatoria | Para qué |
|---|---|---|
| `GOOGLE_API_KEY` | Sí | API key de Gemini (embeddings de referencia de tono). |
| `ANTHROPIC_API_KEY` | Sí | API key de Claude (ortografía, reescribir, crear). |
| `PORT` | No (default `3000`) | Puerto del server. |
| `META_ACCESS_TOKEN` | Solo para `npm run fetch-meta-ads` | Token de Meta Marketing API, para extraer copys de anuncios reales. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | No (activa el login con Google si están las dos) | Ver [Login con Google](#login-con-google). |
| `ALLOWED_EMAIL_DOMAIN` | No (default `benandfrank.com`) | Dominio de correo permitido para iniciar sesión. |
| `PUBLIC_SERVER_URL` | No (default `https://topito-server.onrender.com`) | URL pública del server, para construir el redirect de OAuth. |
| `GEMINI_MODEL_FAST`, `CLAUDE_MODEL_ORTOGRAFIA`, `CLAUDE_MODEL_REESCRIBIR`, `CLAUDE_MODEL_GENERATE` | No | Sobreescriben los modelos por defecto. |

## Endpoints

### Generación (requieren sesión si el login con Google está activo — ver abajo)

- `POST /ortografia` — `{ prompt, brand }` → `{ correctedText }`. Corrige
  ortografía/tildes/voseo sin cambiar tono ni vocabulario. Usa Claude Haiku
  (barato, tarea mecánica).
- `POST /reescribir` — `{ prompt, brand, format }` → `{ correctedText }`
  (una lista con hasta 4 opciones separadas por `*`). Reescribe el texto con
  el tono de la marca. Usa Claude Sonnet.
- `POST /generate` — `{ prompt, brand, format }` → `{ text }` (hasta 4
  opciones). Genera copy nuevo a partir de una instrucción libre. Usa Claude
  Sonnet.
- `POST /feedback` — `{ text, rating, source, brand, original? }` con
  `rating` en `like`/`neutral`/`bad`. Guarda la calificación en
  `feedback-log.jsonl`; un `like` además se agrega como ejemplo de tono nuevo
  para esa marca (`data/<marca>/tuning.json`).

`format` acepta: `general` (default), `headline` (≤40), `primario` (1ª línea
≤125), `caption`, `web`, `email` (asunto ≤50 + preheader ≤90), `google_ads`
(título ≤30 + descripción ≤90), `hook` (≤80) y `cta` (≤25) — ver `FORMATS` en
`server.mjs`.

Desde la Fase 2 el modelo responde en JSON (`copy-engine.mjs`): el server mide
cada campo, y si una opción se pasa del límite pide **una** versión recortada
solo de esas. `/reescribir` y `/generate` siguen devolviendo la lista `* opción`
de siempre (`correctedText` / `text`) y además `options` (texto, ángulo, campos
con conteo y `ok`) y `references` (cuántos ejemplos de tono se usaron y el más
parecido). En **crear**, cada opción usa un ángulo distinto: precio, estilo,
beneficio o urgencia.

### Login con Google

- `GET /auth/google/enabled` — sin efectos secundarios, dice si el login está
  activo (`{ enabled: true|false }`). El plugin lo consulta al abrir (antes
  de tener sesión) para decidir si mostrar el gate de login de una vez.
- `GET /auth/google/start` — arranca un intento de login, devuelve
  `{ loginId, url }`.
- `GET /auth/google/status?loginId=...` — el plugin pregunta esto cada pocos
  segundos mientras espera. Devuelve `{ status: "pending" | "done" | "denied" | "expired", ... }`.
- `GET /auth/google/callback` — a donde Google redirige después del login
  (nunca se llama directo).
- `POST /auth/logout` — con header `Authorization: Bearer <token>`, cierra
  esa sesión.

### Utilidad / reportes (sin autenticación)

- `GET /health` — ping simple, no gasta cuota de IA. Usado por el workflow de
  keep-alive.
- `GET /brands` — marcas disponibles + cuántos ejemplos de tono tiene cada una.
- `GET /usage` (`?days=N`) — totales de requests y tokens consumidos, con
  costo estimado.
- `GET /feedback-summary` (`?brand=...`) — conteo de 👍/⚪/bad por marca y por
  origen (`reescribir`/`crear`).
- `GET /dashboard` — mini-dashboard visual (HTML estático en
  `public/dashboard.html`) que consume `/usage` y `/feedback-summary`.

## Login con Google

**Objetivo:** que solo gente con correo `@benandfrank.com` pueda usar el
plugin — importante porque en algún momento va a estar público en la
Community de Figma y cada uso gasta cuota de Claude/Gemini.

### Cómo funciona

Un plugin de Figma vive en un iframe sandboxeado: no puede recibir un
redirect de OAuth directamente. Por eso el flujo pasa por el navegador normal
de la persona:

1. El plugin le pide al server un intento de login (`GET /auth/google/start`).
2. El plugin abre la URL de Google que le regresa el server **en el navegador
   del sistema** (no dentro de Figma) y empieza a preguntar el estado con
   `GET /auth/google/status` cada pocos segundos.
3. La persona inicia sesión con Google ahí, en su navegador normal.
4. Google redirige a `GET /auth/google/callback` en este server, que valida
   el `id_token`, revisa que el correo sea del dominio permitido, y genera un
   token de sesión propio (no el de Google) para el plugin.
5. La siguiente vez que el plugin pregunta el estado, ve `"done"` con su
   token y lo guarda (`figma.clientStorage`) para mandarlo en cada llamada
   (`Authorization: Bearer <token>`) mientras dure la sesión. La sesión no
   expira sola — solo termina si la persona cierra sesión a propósito o el
   server pierde el registro (por ejemplo, un redeploy de Render, ya que las
   sesiones se guardan en un archivo local, no en una base de datos).

**Mientras `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` no estén
configurados, el login queda desactivado y el server sigue funcionando
exactamente como antes, sin pedirle nada a nadie.** Esto es a propósito, para
poder desplegar este cambio ya mismo sin romper el uso actual, y activar el
login después con solo poner esas dos variables en Render — sin tocar código
ni volver a desplegar nada más.

### Configurar Google Cloud (paso a paso)

1. Entra a [Google Cloud Console](https://console.cloud.google.com/) con una
   cuenta `@benandfrank.com` y crea un proyecto nuevo (o usa uno existente),
   por ejemplo "Topito Writer".
2. Ve a **APIs & Services → OAuth consent screen**.
   - Tipo de usuario: si la cuenta de Google Workspace de Ben & Frank lo
     permite, elige **Internal** (así solo gente del Workspace puede
     siquiera intentar el login, como capa extra además de la validación de
     dominio que ya hace el server). Si no está disponible, usa **External**
     y dejar el consent screen en modo "Testing" o publicarlo — el server
     igual rechaza cualquier correo que no sea `@benandfrank.com`.
   - Llena nombre de la app, correo de soporte, y logo si quieres.
3. Ve a **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
   - Tipo de aplicación: **Web application**.
   - Nombre: por ejemplo "topito-writer server".
   - En **Authorized redirect URIs** agrega exactamente:
     `https://topito-server.onrender.com/auth/google/callback`
     (o la URL que corresponda si `PUBLIC_SERVER_URL` cambia).
   - Guarda y copia el **Client ID** y el **Client Secret** que te da Google.
4. En el dashboard de Render de este servicio, ve a **Environment** y agrega:
   - `GOOGLE_OAUTH_CLIENT_ID` = el Client ID del paso anterior.
   - `GOOGLE_OAUTH_CLIENT_SECRET` = el Client Secret del paso anterior.
   - (Opcional) `ALLOWED_EMAIL_DOMAIN` si el dominio no es `benandfrank.com`.
5. Guarda — Render vuelve a desplegar automáticamente con las variables
   nuevas. Desde ese momento, cualquiera que abra el plugin y llegue a
   `/ortografia`, `/reescribir`, `/generate` o `/feedback` sin sesión va a
   ver la pantalla de "Iniciar sesión con Google" (ver README del plugin).
6. Prueba el flujo completo con tu propio correo `@benandfrank.com` desde el
   plugin, en un archivo de Figma cualquiera.

No hace falta ninguna librería nueva: la verificación del `id_token` se hace
contra el endpoint público `tokeninfo` de Google
(`https://oauth2.googleapis.com/tokeninfo?id_token=...`), sin dependencias
extra.

## Bot de Slack (Topito)

El mismo server expone un asistente de copy para Slack (`slack.mjs`) que usa
**exactamente la misma lógica** que el plugin: ortografía, reescribir, crear,
feedback 👍/⚪ (alimenta `data/<marca>/tuning.json`) y reporte de uso.

**Cómo se usa**

- Mencionándolo en un canal: `@Topito escribe 3 headlines para lentes de sol`.
- Por DM, en lenguaje natural: "reescribe con nuestro tono: …", "revisa la
  ortografía de: …", "reporte de uso de los últimos 7 días".
- En el mismo hilo puede iterar: "más corto", "ahora para Bombavista".
- Menú ⋯ de cualquier mensaje → **Reescribir con Topito** (abre un modal con
  marca y formato) o **Revisar ortografía**. El resultado llega por DM.

Un router barato (Claude Haiku con tool-use) interpreta cada mensaje y decide
acción, marca, formato y texto; luego se llama a `ortografiaCore`,
`reescribirCore` o `generateCore`. El costo del router se registra en
`/usage` como `slack/router`.

**Endpoints**: `POST /slack/events` (Events API) y `POST /slack/interactions`
(botones, atajos, modal). Ambos verifican la firma de Slack.

**Seguridad**: firma HMAC + anti-replay; solo usuarios con correo
`@ALLOWED_EMAIL_DOMAIN`; se ignoran bots/ediciones/reintentos (sin bucles);
límite por usuario (`SLACK_RATE_LIMIT`); opcional `SLACK_ALLOWED_TEAM_ID` y
`SLACK_ADMIN_USER_IDS`.

**Instalación**

1. https://api.slack.com/apps → *Create New App* → *From a manifest* → pega
   `slack-app-manifest.yml` y elige el workspace de Ben & Frank.
2. *Install to Workspace*. Copia el **Bot User OAuth Token** (`xoxb-…`) y, en
   *Basic Information*, el **Signing Secret**.
3. En Render → Environment agrega `SLACK_BOT_TOKEN` y `SLACK_SIGNING_SECRET`
   (y los opcionales). Render redepliega.
4. En la app de Slack → *Event Subscriptions*, pulsa *Retry* en la Request URL
   para que se verifique (el server ya debe estar arriba con las variables).
5. Invita a `@Topito` a los canales donde lo quieras usar (`/invite @Topito`).

Nota: las preferencias de marca por usuario se guardan en
`data/slack-prefs.json` (se pierden en un redeploy, igual que las sesiones).

## Persistencia (Supabase + Google Sheets)

Render borra el disco en cada deploy, así que los datos importantes viven fuera
(ver `storage.mjs`, todo opcional y sin dependencias):

- **Supabase** (plan gratis) es la fuente de verdad: `usage_log`, `feedback`,
  `copy_bank` (los 👍), `slack_prefs` y `figma_inbox`. El esquema está en
  `supabase-schema.sql` (RLS activo sin políticas: solo el server con la
  `SUPABASE_SERVICE_KEY` puede leer/escribir). `/usage` y `/feedback-summary`
  leen de aquí cuando está configurado. Al arrancar, los 👍 se vuelven a sumar
  como ejemplos de tono, y el workflow semanal los pasa a `tuning.json`
  (`npm run sync-likes`) para que tengan embedding.
- **Google Sheet "Topito – Banco de copys y glosario"** vía Apps Script
  (`apps-script/Code.gs`): espejo del banco de copys para Content y pestaña
  **Glosario** (Marca | Tipo | Término | Nota) que Content edita. El server lo
  relee cada 5 min, lo mete en los prompts de reescribir/crear, y en Slack marca
  con ⚠️ las opciones que usen palabras prohibidas.

Variables: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TOPITO_SHEET_WEBHOOK_URL`,
`TOPITO_SHEET_SECRET` (y en GitHub Actions: secrets `SUPABASE_URL` y
`SUPABASE_SERVICE_KEY` para `sync-likes`).

## Marcas y formatos

Marcas soportadas (`BRANDS` en `server.mjs`): `benandfrank` (Ben & Frank,
default) y `bombavista`. Cada una tiene su propia carpeta de referencias de
tono en `data/<marca>/`.

Formatos/canales soportados (`FORMATS` en `server.mjs`, usados en
`/reescribir` y `/generate`): `general`, `headline`, `primario`, `caption`,
`web` — cada uno le da al prompt una guía distinta según dónde se va a usar
el copy (ver la tabla de `guidance` en el código para el detalle exacto).

## Scripts

- `npm run build-embeddings` — precalcula embeddings de cada ejemplo de tono
  en `data/<marca>/tuning.json` y los guarda en
  `data/<marca>/tuning-embeddings.json`. Se puede correr varias veces
  seguidas (retoma donde se quedó).
- `npm run fetch-meta-ads` — extrae copys de anuncios reales de Meta Ads para
  cada marca y los agrega a `data/<marca>/tuning.json` (sin duplicar).
  Requiere `META_ACCESS_TOKEN`. Primera corrida hace backfill completo (puede
  tardar varias corridas); corridas siguientes son incrementales.
- `npm test` — corre `test.mjs` (smoke test básico).

Después de `fetch-meta-ads` hay que correr `build-embeddings` para que los
ejemplos nuevos entren a la búsqueda por similitud (si no, solo se usan como
respaldo aleatorio).

## Automatizaciones (GitHub Actions)

- `.github/workflows/refresh-brand-data.yml` — corre **diario** (9:00 UTC) y
  también se puede disparar manual desde la pestaña Actions. Ejecuta
  `fetch-meta-ads` → `sync-likes` (👍 de Supabase) → `build-embeddings`, cada
  uno con su propio presupuesto de tiempo, y **siempre** sube a `main` lo que
  haya avanzado (Render despliega automáticamente). El progreso del backfill se
  guarda en `data/<marca>/.meta-ads-progress.json` (sin token) para que cada
  corrida siga donde se quedó la anterior. El resumen de cada corrida muestra
  ejemplos/embeddings antes y después (`scripts/kb-stats.mjs`).
- `.github/workflows/keep-alive.yml` — ping a `/health` cada 10 minutos para
  que Render (free tier) no duerma el server por inactividad. No gasta cuota
  de IA.

## Deploy

El server está desplegado en Render y se despliega automáticamente con cada
push a `main`. Las variables de entorno (API keys, y las de Google OAuth
cuando se activen) se configuran en el dashboard de Render, nunca en el
repo — `.env` está en `.gitignore`.
