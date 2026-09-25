import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { registerSlackRoutes } from "./slack.mjs";
import { createStorage } from "./storage.mjs";
import {
	ANGLES,
	outputInstructions,
	parseCopyResponse,
	checkOption,
	optionText,
	toLegacyList,
	shortenPrompt,
	cleanReferenceList,
	normalizeCopy,
	isJunkCopy,
	FEEDBACK_REASONS,
	cleanReasons,
} from "./copy-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Guardamos el body crudo (rawBody) porque Slack firma los requests con HMAC sobre
// el body exacto -- ver slack.mjs > verifySlackSignature. No afecta al plugin.
const keepRawBody = (req, res, buf) => {
	req.rawBody = buf.toString("utf8");
};
// JSON normal (100 kb); solo la ruta de imagen acepta cuerpos grandes (base64).
const jsonDefault = express.json({ verify: keepRawBody });
const jsonLarge = express.json({ verify: keepRawBody, limit: "8mb" });
app.use((req, res, next) => (req.path === "/internal/image-copy" ? jsonLarge : jsonDefault)(req, res, next));
app.use(express.urlencoded({ extended: true, verify: keepRawBody }));

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = (process.env.ANTHROPIC_API_URL || "https://api.anthropic.com").replace(/\/$/, "");

// Gemini free-tier tiene un límite de ~20 peticiones/minuto por modelo que se nos
// agotó fácil en pruebas, y flash-lite además se comía tildes reales (ej. "estás" ->
// "estas") y typos dobles (ej. "mismmo"). Por eso, por el momento, /ortografia se
// mueve a Claude (ver CLAUDE_MODEL_ORTOGRAFIA) y no se usa Gemini para generación.
// GEMINI_MODEL_FAST queda sin uso mientras tanto -- se deja definida por si se
// quiere volver a Gemini más adelante (ej. si se resuelve la cuota).
const GEMINI_MODEL_FAST = process.env.GEMINI_MODEL_FAST || "gemini-2.5-flash";
// Ortografía: tarea mecánica y de alto volumen -> Haiku (barato). Reescribir y Crear: copy de marca -> Sonnet, que respeta mejor el tono.
const CLAUDE_MODEL_ORTOGRAFIA = process.env.CLAUDE_MODEL_ORTOGRAFIA || "claude-haiku-4-5-20251001";
const CLAUDE_MODEL_REESCRIBIR = process.env.CLAUDE_MODEL_REESCRIBIR || "claude-sonnet-5";
const CLAUDE_MODEL_GENERATE = process.env.CLAUDE_MODEL_GENERATE || "claude-sonnet-5";
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;
const REFERENCE_TOP_K = Number(process.env.REFERENCE_TOP_K) || 12;
const REFERENCE_MAX_SIMILARITY = Number(process.env.REFERENCE_MAX_SIMILARITY) || 0.93;
// Cuánto pesa el desempeño en Meta al elegir referencias (el parecido va de ~0.5 a ~0.85;
// con 0.08, un texto top (score 1) le gana a uno sin datos con hasta 0.04 menos de parecido).
const PERFORMANCE_WEIGHT = Number(process.env.PERFORMANCE_WEIGHT ?? 0.08);
const TOP_PERFORMER_SCORE = 0.8;

if (!GOOGLE_API_KEY) {
	console.error(
		"Falta la variable de entorno GOOGLE_API_KEY. Crea un archivo .env (copia .env.example) con tu API key de Gemini.",
	);
	process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
	console.error(
		"Falta la variable de entorno ANTHROPIC_API_KEY. Crea un archivo .env (copia .env.example) con tu API key de Anthropic.",
	);
	process.exit(1);
}

// Middleware manual de CORS
app.use((req, res, next) => {
	res.header("Access-Control-Allow-Origin", "*"); // permite cualquier origen
	res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
	if (req.method === "OPTIONS") {
		return res.sendStatus(200); // responde al preflight
	}
	next();
});

// Endpoint de salud: no toca ninguna IA ni gasta tokens -- pensado para que un
// cronjob externo haga ping periódico y evite que Render duerma el server por
// inactividad, sin que eso cueste nada de uso de Gemini/Claude.
app.get("/health", (req, res) => {
	res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
});

// --- Login con Google, restringido a un dominio ---
//
// Objetivo: que solo gente con correo @benandfrank.com (o el dominio que se
// configure) pueda usar el plugin, ya que en algún momento va a estar público
// en la Community de Figma y cada uso gasta cuota de Claude/Gemini.
//
// Flujo (pensado para un plugin de Figma, que no puede recibir un redirect de
// OAuth directamente porque vive en un iframe sandboxeado):
//   1. El plugin pide un intento de login: GET /auth/google/start.
//   2. El plugin abre la URL de Google que le regresamos en el navegador del
//      sistema (window.open desde ui.html) y empieza a preguntar el estado
//      con GET /auth/google/status?loginId=... cada pocos segundos.
//   3. La persona inicia sesión con Google ahí, en su navegador normal.
//   4. Google redirige a GET /auth/google/callback en este servidor, que
//      valida el id_token, revisa que el correo sea del dominio permitido, y
//      genera un token de sesión propio (no el de Google) para el plugin.
//   5. La siguiente vez que el plugin pregunta el estado, ve "done" con su
//      token y lo guarda (figma.clientStorage) para mandarlo en cada llamada
//      (header Authorization: Bearer <token>) mientras dure la sesión --  ver
//      requireAuth() más abajo, que la valida en cada request a /ortografia,
//      /reescribir, /generate y /feedback.
//
// Mientras GOOGLE_OAUTH_CLIENT_ID/SECRET no estén configurados (ver
// .env.example y el README), AUTH_ENABLED queda en false y el servidor sigue
// funcionando exactamente como antes, sin pedir login a nadie -- así no se
// rompe nada mientras se termina de configurar el proyecto de Google Cloud.
const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const ALLOWED_EMAIL_DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "benandfrank.com";
// URL pública de este servidor (la que Google necesita para el redirect_uri
// que se registra en Google Cloud Console). En Render es la misma siempre;
// en local se puede sobreescribir con PUBLIC_SERVER_URL en .env si se quiere
// probar el flujo completo apuntando a un túnel (ngrok, etc.) -- Google no
// deja usar http://localhost como redirect_uri.
const PUBLIC_SERVER_URL = process.env.PUBLIC_SERVER_URL || "https://topito-server.onrender.com";
const GOOGLE_OAUTH_REDIRECT_URI = `${PUBLIC_SERVER_URL}/auth/google/callback`;
const AUTH_ENABLED = Boolean(GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET);

if (!AUTH_ENABLED) {
	console.warn(
		"[auth] GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET no configurados: " +
			"el login con Google está DESACTIVADO y cualquiera con la URL puede usar " +
			"el server. Ver README para configurarlo.",
	);
}

// Sesiones activas (token propio -> { email, createdAt }). No expiran solas
// -- la persona se queda con la sesión iniciada hasta que cierra sesión desde
// el plugin (POST /auth/logout). Se guardan en disco para sobrevivir un
// reinicio del server (Render puede reiniciar el proceso sin avisar).
const SESSIONS_PATH = path.join(__dirname, "data", "sessions.json");

function loadSessions() {
	try {
		return JSON.parse(fs.readFileSync(SESSIONS_PATH, "utf-8"));
	} catch {
		return {};
	}
}

function saveSessions(sessions) {
	fs.writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}

// Intentos de login en curso (loginId -> { status, token?, email?, reason?,
// createdAt }). Viven solo en memoria: son de corta duración (minutos), así
// que no hace falta que sobrevivan un reinicio del server -- si eso pasa a
// mitad de un login, la persona simplemente lo vuelve a intentar.
const pendingLogins = new Map();
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000; // 10 minutos

setInterval(
	() => {
		const now = Date.now();
		for (const [loginId, entry] of pendingLogins) {
			if (now - entry.createdAt > PENDING_LOGIN_TTL_MS) {
				pendingLogins.delete(loginId);
			}
		}
	},
	5 * 60 * 1000,
).unref();

app.get("/auth/google/start", (req, res) => {
	if (!AUTH_ENABLED) {
		return res.status(501).json({
			error: "El login con Google no está configurado en este servidor todavía.",
		});
	}
	const loginId = crypto.randomUUID();
	pendingLogins.set(loginId, { status: "pending", createdAt: Date.now() });

	const params = new URLSearchParams({
		client_id: GOOGLE_OAUTH_CLIENT_ID,
		redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
		response_type: "code",
		scope: "openid email profile",
		state: loginId,
		// "hd" solo ayuda a que Google preseleccione/filtre el dominio en el
		// selector de cuenta -- es una sugerencia de UX, no una garantía de
		// seguridad, por eso el dominio se vuelve a validar de verdad abajo
		// en /auth/google/callback con el id_token ya verificado por Google.
		hd: ALLOWED_EMAIL_DOMAIN,
		prompt: "select_account",
	});
	res.json({
		loginId,
		url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
	});
});

// El plugin lo consulta al abrir (antes de tener sesión) para saber si debe
// mostrar la pantalla de login de una vez o no -- así el gate aparece desde
// el inicio cuando el login está activo, sin romper el modo "fail-open"
// (plugin funcionando normal, sin pedir nada) mientras no esté configurado.
// No tiene efectos secundarios ni requiere sesión.
app.get("/auth/google/enabled", (req, res) => {
	res.json({ enabled: AUTH_ENABLED });
});

app.get("/auth/google/status", (req, res) => {
	const loginId = req.query.loginId;
	const entry = pendingLogins.get(loginId);
	if (!entry) {
		return res.json({ status: "expired" });
	}
	res.json(entry);
	// Un token de sesión solo se debe poder recoger una vez desde aquí.
	if (entry.status === "done" || entry.status === "denied") {
		pendingLogins.delete(loginId);
	}
});

function htmlAuthPage(title, message) {
	return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" />
<title>${title}</title>
<style>
	body { font-family: -apple-system, Arial, sans-serif; background: #fafbef; color: #202020;
		display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
	.card { max-width: 380px; padding: 32px; }
	h1 { font-size: 20px; margin: 0 0 12px; }
	p { font-size: 15px; line-height: 1.5; color: #555; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

app.get("/auth/google/callback", async (req, res) => {
	const { code, state, error: googleError } = req.query;
	const loginId = state;
	if (googleError) {
		if (loginId) pendingLogins.set(loginId, { status: "denied", reason: "cancelado", createdAt: Date.now() });
		return res
			.status(200)
			.send(htmlAuthPage("Inicio de sesión cancelado", "Puedes cerrar esta pestaña y volver a intentarlo desde el plugin."));
	}
	if (!code || !loginId || !pendingLogins.has(loginId)) {
		return res
			.status(400)
			.send(htmlAuthPage("Enlace inválido o vencido", "Vuelve al plugin y dale \"Iniciar sesión con Google\" de nuevo."));
	}

	try {
		const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: GOOGLE_OAUTH_CLIENT_ID,
				client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
				redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
				grant_type: "authorization_code",
			}),
		});
		const tokenData = await tokenRes.json();
		if (!tokenRes.ok || !tokenData.id_token) {
			throw new Error(tokenData.error_description || tokenData.error || "No se pudo obtener el id_token de Google.");
		}

		// Google ya firmó este id_token -- lo validamos contra su propio
		// endpoint en vez de verificar la firma nosotros mismos, para no
		// tener que manejar sus llaves públicas (JWKS) a mano.
		const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${tokenData.id_token}`);
		const info = await infoRes.json();
		if (!infoRes.ok || info.aud !== GOOGLE_OAUTH_CLIENT_ID) {
			throw new Error("id_token inválido.");
		}

		const email = info.email || "";
		const domain = email.split("@")[1] || "";
		if (info.email_verified !== "true" && info.email_verified !== true) {
			throw new Error("Correo no verificado por Google.");
		}
		if (domain.toLowerCase() !== ALLOWED_EMAIL_DOMAIN.toLowerCase()) {
			pendingLogins.set(loginId, { status: "denied", reason: "dominio", email, createdAt: Date.now() });
			return res
				.status(200)
				.send(
					htmlAuthPage(
						"Acceso restringido",
						`Este plugin es solo para correos @${ALLOWED_EMAIL_DOMAIN}. Iniciaste sesión como ${email}. Puedes cerrar esta pestaña.`,
					),
				);
		}

		const token = crypto.randomBytes(32).toString("hex");
		const sessions = loadSessions();
		sessions[token] = { email, createdAt: Date.now() };
		saveSessions(sessions);

		pendingLogins.set(loginId, { status: "done", token, email, createdAt: Date.now() });
		res.status(200).send(htmlAuthPage("¡Listo!", `Iniciaste sesión como ${email}. Ya puedes volver a Figma.`));
	} catch (err) {
		console.error("[/auth/google/callback] Error:", err);
		if (loginId) pendingLogins.set(loginId, { status: "denied", reason: "error", createdAt: Date.now() });
		res
			.status(200)
			.send(htmlAuthPage("Algo salió mal", "No se pudo completar el inicio de sesión. Vuelve al plugin e inténtalo de nuevo."));
	}
});

app.post("/auth/logout", (req, res) => {
	const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
	if (token) {
		const sessions = loadSessions();
		if (sessions[token]) {
			delete sessions[token];
			saveSessions(sessions);
		}
	}
	res.json({ ok: true });
});

// Se llama al inicio de cada endpoint que gasta cuota de IA (o que registra
// datos a nombre de alguien): valida el header "Authorization: Bearer
// <token>" contra las sesiones activas. Mientras AUTH_ENABLED sea false (ver
// arriba) deja pasar todo, para no romper nada mientras se configura Google
// Cloud -- ver README.
function requireAuth(req, res) {
	if (!AUTH_ENABLED) return { email: null };
	const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
	if (!token) {
		res.status(401).json({ error: "auth_required", message: "Inicia sesión con tu correo de Ben & Frank para usar el plugin." });
		return null;
	}
	const sessions = loadSessions();
	const session = sessions[token];
	if (!session) {
		res.status(401).json({ error: "invalid_session", message: "Tu sesión ya no es válida. Inicia sesión de nuevo." });
		return null;
	}
	return session;
}

// --- Marcas soportadas ---
// Cada marca tiene su propio dataset de tono (data/<marca>/tuning.json) y su propio
// cache de embeddings (data/<marca>/tuning-embeddings.json). El plugin manda `brand`
// en el body para elegir con cuál conversar; si no manda nada, se usa DEFAULT_BRAND.
const BRANDS = {
	benandfrank: { label: "Ben & Frank" },
	bombavista: { label: "Bombavista" },
};
const DEFAULT_BRAND = "benandfrank";

// --- Formatos/canales soportados en /reescribir y /generate ---
// El plugin manda `format` en el body para que el copy salga ya ajustado al canal
// donde se va a usar, en vez de un texto genérico que hay que recortar después.
// "general" (default) mantiene el comportamiento de siempre, sin restricciones.
const FORMATS = {
	general: { label: "General", guidance: "" },
	headline: {
		label: "Headline de anuncio",
		guidance:
			"Este texto es el HEADLINE/título grande de un anuncio (Meta, Google, etc). Debe ser muy corto y directo: máximo 6-8 palabras, sin verbos de relleno ni conectores largos. Va solo, sin contexto alrededor, así que tiene que entenderse de un vistazo.",
		fields: [{ key: "texto", label: "Headline", max: 40 }],
	},
	primario: {
		label: "Texto primario de anuncio",
		guidance:
			"Este texto es el CUERPO/texto primario de un anuncio de Meta o Instagram. Las plataformas lo cortan con un botón 'ver más' alrededor de los 125 caracteres, así que el gancho principal tiene que ir en la primera línea. Puede tener 2-3 líneas cortas en total.",
		fields: [{ key: "texto", label: "Texto", firstLineMax: 125 }],
	},
	caption: {
		label: "Caption de redes sociales",
		guidance:
			"Este texto es un caption para Instagram u otra red social. Tono cercano y conversacional, como si le hablaras directo a un seguidor. Puede usar emojis y un hashtag al final si el ejemplo de tono los usa, y puede ser un poco más largo que un anuncio.",
		fields: [{ key: "texto", label: "Caption", max: 2200 }],
	},
	web: {
		label: "Copy de página web",
		guidance:
			"Este texto es para una página del sitio web (no un anuncio). Debe ser claro y enfocado en el beneficio para el cliente, sin la urgencia de un anuncio pagado. No tiene límite estricto de longitud, pero cada oración debe aportar algo -- nada de relleno.",
	},
	// --- Fase 2 ---
	email: {
		label: "Email (asunto + preheader)",
		guidance:
			"Es el ASUNTO y el PREHEADER de un email de marketing. El asunto tiene que dar ganas de abrir sin sonar a spam (nada de MAYÚSCULAS completas ni exceso de signos). El preheader complementa al asunto -- no lo repite -- y adelanta el beneficio.",
		fields: [
			{ key: "asunto", label: "Asunto", max: 50 },
			{ key: "preheader", label: "Preheader", max: 90 },
		],
	},
	google_ads: {
		label: "Google Ads (responsivo)",
		guidance:
			"Es un anuncio responsivo de búsqueda de Google Ads: un TÍTULO muy corto y una DESCRIPCIÓN. Deben funcionar solos y en cualquier combinación, con la palabra clave del producto de forma natural. Sin signos de exclamación en el título.",
		fields: [
			{ key: "titulo", label: "Título", max: 30 },
			{ key: "descripcion", label: "Descripción", max: 90 },
		],
	},
	hook: {
		label: "Hook de video (TikTok/Reels)",
		guidance:
			"Es el HOOK de los primeros 3 segundos de un video de TikTok/Reels: se dice en voz alta o va como texto en pantalla. Tiene que detener el scroll: pregunta, contraste o dato inesperado. Máximo ~12 palabras, lenguaje hablado.",
		fields: [{ key: "texto", label: "Hook", max: 80 }],
	},
	cta: {
		label: "CTA / botón",
		guidance:
			"Es el texto de un BOTÓN o llamado a la acción. Verbo en imperativo, 1 a 4 palabras, claro sobre lo que pasa al hacer clic.",
		fields: [{ key: "texto", label: "CTA", max: 25 }],
	},
};
const DEFAULT_FORMAT = "general";

function resolveFormat(format) {
	return FORMATS[format] ? format : DEFAULT_FORMAT;
}
const MAX_REFERENCE_TEXT_LENGTH = 400; // descarta texto legal (avisos de privacidad, TyC, etc.)

// fetch con timeout: si Gemini/Claude se cuelgan, la petición del plugin no se
// queda esperando para siempre -- después de FETCH_TIMEOUT_MS se aborta y se
// convierte en un error manejado normal (ver respondWithError).
const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url, options = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...options, signal: controller.signal });
	} catch (err) {
		if (err.name === "AbortError") {
			const timeoutError = new Error("La API tardó demasiado en responder.");
			timeoutError.details = { message: "timeout", timeoutMs: FETCH_TIMEOUT_MS };
			throw timeoutError;
		}
		throw err;
	} finally {
		clearTimeout(timeout);
	}
}

// Algunas fallas (proxy caído, 502 de Cloudflare, etc.) devuelven HTML en vez de
// JSON -- sin esto, response.json() tronaría con un SyntaxError poco claro.
async function parseJsonResponse(response, providerLabel) {
	try {
		return await response.json();
	} catch {
		const error = new Error(`Respuesta inválida de ${providerLabel} (status ${response.status}).`);
		error.details = { status: response.status };
		throw error;
	}
}

// Log completo (con detalles internos) para nosotros, pero al plugin solo le
// llega un mensaje genérico y seguro -- nunca el objeto de error crudo del
// proveedor, que puede traer detalles que no le corresponden al cliente.
function respondWithError(res, err, context) {
	console.error(`[${context}] Error:`, err.details ?? err);
	const code = err.details?.code;
	const status = err.details?.status;
	const type = err.details?.type;
	// 429 = rate limit; 503/UNAVAILABLE = el modelo de Gemini está saturado (no es
	// culpa nuestra, y reintentar en unos segundos casi siempre funciona) -- ambos
	// casos son "el proveedor está saturado", así que comparten el mismo mensaje.
	const isRateLimited =
		code === 429 ||
		code === 503 ||
		status === "UNAVAILABLE" ||
		type === "rate_limit_error" ||
		type === "overloaded_error";
	const isTimeout = err.details?.message === "timeout";

	if (isRateLimited) {
		return res.status(429).json({ error: "El servicio de IA está saturado en este momento. Intenta de nuevo en unos segundos." });
	}
	if (isTimeout) {
		return res.status(504).json({ error: "La IA tardó demasiado en responder. Intenta de nuevo." });
	}
	return res.status(500).json({ error: "Ocurrió un error al procesar la solicitud. Intenta de nuevo en unos momentos." });
}

function cosineSimilarity(a, b) {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Mezcla Fisher-Yates: no muta el array original y da una distribución uniforme
function shuffle(arr) {
	const copy = [...arr];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j], copy[i]];
	}
	return copy;
}

function loadBrandData(brandKey) {
	const dir = path.join(__dirname, "data", brandKey);
	const tuningPath = path.join(dir, "tuning.json");
	const embeddingsPath = path.join(dir, "tuning-embeddings.json");

	let rawReferenceData = [];
	try {
		rawReferenceData = JSON.parse(fs.readFileSync(tuningPath, "utf-8"));
	} catch {
		console.warn(`Aviso: no se encontró ${tuningPath}; "${brandKey}" no tiene ejemplos de tono todavía.`);
	}

	// Sin páginas legales ni duplicados normalizados (ver copy-engine.mjs).
	const referenceData = cleanReferenceList(
		rawReferenceData.filter((item) => (item.text?.length ?? 0) > 0 && item.text.length <= MAX_REFERENCE_TEXT_LENGTH),
	);
	console.log(
		`[${brandKey}] Referencia de tono: ${referenceData.length}/${rawReferenceData.length} textos usados ` +
			`(se descartaron ${rawReferenceData.length - referenceData.length} por vacíos o demasiado largos).`,
	);

	let referenceEmbeddings = null;
	try {
		const cache = JSON.parse(fs.readFileSync(embeddingsPath, "utf-8"));
		const cachedTexts = new Set(cache.items.map((i) => i.text));
		const missing = referenceData.filter((item) => !cachedTexts.has(item.text)).length;
		if (missing > 0) {
			console.warn(
				`[${brandKey}] Aviso: faltan ${missing} texto(s) en tuning-embeddings.json. ` +
					`Corre "npm run build-embeddings" para actualizarlo.`,
			);
		}
		// Solo vectores de textos que siguen en la referencia limpia.
		const validTexts = new Set(referenceData.map((i) => i.text));
		referenceEmbeddings = cache.items.filter((i) => validTexts.has(i.text) && !isJunkCopy(i));
		console.log(`[${brandKey}] Embeddings cargados: ${referenceEmbeddings.length} vectores.`);
	} catch {
		if (referenceData.length > 0) {
			console.warn(
				`[${brandKey}] Aviso: no se encontró tuning-embeddings.json. Corre "npm run build-embeddings" ` +
					`para activar la selección por relevancia; mientras tanto se usa muestreo al azar.`,
			);
		}
	}

	// Desempeño real en Meta (scripts/fetch-ad-performance.mjs): score 0..1 por texto.
	const performance = new Map();
	try {
		const perf = JSON.parse(fs.readFileSync(path.join(dir, "performance.json"), "utf-8"));
		for (const it of perf.items || []) performance.set(it.key, it);
		console.log(`[${brandKey}] Desempeño cargado: ${performance.size} textos con score.`);
	} catch {
		/* todavía no hay performance.json: se rankea solo por parecido */
	}

	return { referenceData, referenceEmbeddings, performance };
}

// Score de desempeño (0..1) de un texto, o null si no hay datos suficientes.
function performanceOf(brand, text) {
	return brandData[brand]?.performance?.get(normalizeCopy(text))?.score ?? null;
}

const brandData = {};
for (const brandKey of Object.keys(BRANDS)) {
	brandData[brandKey] = loadBrandData(brandKey);
}

// --- Persistencia (Supabase + Google Sheets, ver storage.mjs) ---
// Render borra el disco en cada deploy: los 👍 guardados en Supabase se vuelven
// a sumar aquí como ejemplos de tono (muestreo al azar) para no perderlos.
const storage = createStorage({ fetchWithTimeout });
storage.loadLikedCopies().then((rows) => {
	let added = 0;
	for (const { brand, text } of rows) {
		const data = brandData[brand];
		if (!data || !text || text.length > MAX_REFERENCE_TEXT_LENGTH) continue;
		if (data.referenceData.some((item) => item.text === text)) continue;
		data.referenceData.push({ url: null, source: "feedback-like", text });
		added++;
	}
	if (rows.length) console.log(`[storage] ${added} copys 👍 de Supabase agregados como referencia de tono.`);
});

// 👎 explícitos por marca (más recientes primero), para decirle al modelo qué evitar,
// y "lecciones": los motivos (chips + comentario) de ⚪/👎 de las últimas semanas.
const DISLIKES_IN_PROMPT = 6;
const dislikesByBrand = {}; // brand -> [{ text, reasons, comment }]
const lessonsByBrand = {}; // brand -> [{ rating, text, reasons, comment, country }]
const reasonLabel = (r) => FEEDBACK_REASONS[r] || r;
async function refreshDislikes() {
	const [rows, lessons] = await Promise.all([storage.loadDislikes(), storage.loadFeedbackLessons()]);
	const next = {};
	for (const { brand, text, reasons, comment } of rows) {
		if (!text) continue;
		(next[brand] ||= []).length < DISLIKES_IN_PROMPT * 2 && next[brand].push({ text, reasons: reasons || [], comment: comment || "" });
	}
	const nextLessons = {};
	for (const l of lessons) (nextLessons[l.brand] ||= []).push(l);
	for (const b of Object.keys(BRANDS)) {
		dislikesByBrand[b] = next[b] || [];
		lessonsByBrand[b] = nextLessons[b] || [];
	}
}
refreshDislikes().catch(() => {});
setInterval(() => refreshDislikes().catch(() => {}), 10 * 60 * 1000).unref();

function dislikesPrompt(brand) {
	const list = (dislikesByBrand[brand] || []).slice(0, DISLIKES_IN_PROMPT);
	if (!list.length) return "";
	return `\nEl equipo RECHAZÓ estas opciones anteriores. No te parezcas a ellas (ni en estructura, ni en frases, ni en arranque):\n${list
		.map((d) => {
			const why = [...(d.reasons || []).map(reasonLabel), d.comment].filter(Boolean).join("; ");
			return `- ${d.text.replace(/\s+/g, " ").slice(0, 300)}${why ? ` (motivo: ${why.slice(0, 200)})` : ""}`;
		})
		.join("\n")}\n`;
}

// Resumen de lo que el equipo ha corregido (motivos más repetidos + comentarios recientes).
function lessonsPrompt(brand) {
	const lessons = lessonsByBrand[brand] || [];
	if (!lessons.length) return "";
	const counts = {};
	for (const l of lessons) for (const r of l.reasons || []) counts[r] = (counts[r] || 0) + 1;
	const top = Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 4)
		.map(([r, n]) => `${reasonLabel(r)} (${n})`);
	const comments = lessons
		.filter((l) => l.comment)
		.slice(0, 5)
		.map((l) => `- "${l.comment.replace(/\s+/g, " ").slice(0, 200)}"`);
	if (!top.length && !comments.length) return "";
	return `\nLo que el equipo ha corregido últimamente en los copys de Topito (tenlo muy en cuenta):${top.length ? `\n- Motivos más repetidos: ${top.join(", ")}.` : ""}${comments.length ? `\nComentarios recientes:\n${comments.join("\n")}` : ""}\n`;
}

function resolveBrand(req, res) {
	const brand = req.body?.brand || DEFAULT_BRAND;
	if (!BRANDS[brand]) {
		res.status(400).json({ error: `Marca desconocida: "${brand}". Usa una de: ${Object.keys(BRANDS).join(", ")}` });
		return null;
	}
	return brand;
}

function buildStyleReference(brand, sampleSize = 20) {
	const { referenceData } = brandData[brand];
	if (referenceData.length === 0) return "";
	// Mitad de la muestra sale de los textos con mejor desempeño en Meta (si hay).
	const top = shuffle(referenceData.filter((i) => (performanceOf(brand, i.text) ?? 0) >= TOP_PERFORMER_SCORE)).slice(0, Math.floor(sampleSize / 2));
	const topSet = new Set(top);
	const rest = shuffle(referenceData.filter((i) => !topSet.has(i))).slice(0, sampleSize - top.length);
	return [...top.map((i) => `★ ${i.text}`), ...rest.map((i) => i.text)].join("\n\n");
}

// Igual que buildStyleReference pero con metadatos para mostrar "inspirado en…".
function randomReference(brand) {
	const text = buildStyleReference(brand);
	const items = text ? text.split("\n\n").map((t) => ({ text: t.replace(/^★ /, ""), score: null })) : [];
	return { text, method: "random", items, topPerformers: (text.match(/^★ /gm) || []).length };
}

// Embedding del texto de la petición (RETRIEVAL_QUERY), para compararlo contra los
// embeddings de referencia (RETRIEVAL_DOCUMENT) y elegir los más relevantes.
// Caché en memoria (misma petición = mismo vector) y "corte" cuando Gemini dice
// que se acabó la cuota: así no gastamos la cuota diaria (~1,000/día en free
// tier, compartida con el workflow) ni esperamos una llamada que va a fallar.
const QUERY_CACHE_MAX = 500;
const queryEmbeddingCache = new Map();
let embedPausedUntil = 0;

function nextQuotaReset() {
	// La cuota diaria de Gemini se reinicia a medianoche hora del Pacífico (~07:00-08:00 UTC).
	const d = new Date();
	d.setUTCHours(8, 5, 0, 0);
	if (d.getTime() <= Date.now()) d.setUTCDate(d.getUTCDate() + 1);
	return d.getTime();
}

async function embedQuery(text) {
	const key = normalizeCopy(text).slice(0, 2000);
	const cached = queryEmbeddingCache.get(key);
	if (cached) {
		queryEmbeddingCache.delete(key); // LRU: al final = usado recientemente
		queryEmbeddingCache.set(key, cached);
		return { vector: cached, cached: true };
	}
	if (Date.now() < embedPausedUntil) {
		const err = new Error("Embeddings en pausa por cuota de Gemini");
		err.paused = true;
		throw err;
	}
	try {
		const vector = await embedQueryRemote(text);
		queryEmbeddingCache.set(key, vector);
		if (queryEmbeddingCache.size > QUERY_CACHE_MAX) queryEmbeddingCache.delete(queryEmbeddingCache.keys().next().value);
		return { vector, cached: false };
	} catch (err) {
		if (err.details?.code === 429) {
			const daily = (err.details.details || []).some((d) => (d.violations || []).some((v) => /PerDay/i.test(v.quotaId || "")));
			embedPausedUntil = daily ? nextQuotaReset() : Date.now() + 60_000;
			console.warn(`[embeddings] Cuota de Gemini agotada (${daily ? "diaria" : "por minuto"}); pausa hasta ${new Date(embedPausedUntil).toISOString()}.`);
		}
		throw err;
	}
}

async function embedQueryRemote(text) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${GOOGLE_API_KEY}`;
	const res = await fetchWithTimeout(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: `models/${EMBEDDING_MODEL}`,
			content: { parts: [{ text }] },
			taskType: "RETRIEVAL_QUERY",
			outputDimensionality: EMBEDDING_DIMENSIONS,
		}),
	});
	const data = await parseJsonResponse(res, "Gemini embeddings");
	if (data.error) {
		const error = new Error(data.error.message || "Error de Gemini embeddings");
		error.details = data.error;
		throw error;
	}
	return data.embedding.values;
}

// Construye el bloque de ejemplos de tono para el prompt: los REFERENCE_TOP_K textos
// más parecidos (por embeddings) al texto de la petición, dentro de la marca elegida.
// Si esa marca no tiene embeddings o algo falla, cae de vuelta al muestreo al azar.
async function buildRelevantReference(promptText, endpointForLog, brand) {
	const { referenceEmbeddings } = brandData[brand];
	if (!referenceEmbeddings || referenceEmbeddings.length === 0) {
		return randomReference(brand);
	}

	try {
		const { vector: queryVector, cached } = await embedQuery(promptText);
		if (!cached) logUsage({
			endpoint: `${endpointForLog}:embedding`,
			provider: "gemini-embedding",
			model: EMBEDDING_MODEL,
			inputTokens: Math.ceil(promptText.length / 4), // la API no regresa uso para embeddings; estimado
			outputTokens: 0,
		});

		const sorted = referenceEmbeddings
			.map((item) => {
				const similarity = cosineSimilarity(queryVector, item.embedding);
				const perf = performanceOf(brand, item.text);
				// Sin datos de desempeño = neutral (0.5): ni premia ni castiga.
				const score = similarity + PERFORMANCE_WEIGHT * ((perf ?? 0.5) - 0.5);
				return { item, score, similarity, perf };
			})
			.sort((a, b) => b.score - a.score);
		// Variedad: si un candidato es casi idéntico (≥ REFERENCE_MAX_SIMILARITY) a uno ya
		// elegido -- ej. el mismo anuncio con otro precio --, se salta y se toma el siguiente.
		const ranked = [];
		for (const cand of sorted) {
			if (ranked.length >= REFERENCE_TOP_K) break;
			if (ranked.some((r) => cosineSimilarity(r.item.embedding, cand.item.embedding) >= REFERENCE_MAX_SIMILARITY)) continue;
			ranked.push(cand);
		}

		return {
			text: ranked.map((r) => (r.perf != null && r.perf >= TOP_PERFORMER_SCORE ? `★ ${r.item.text}` : r.item.text)).join("\n\n"),
			method: "embeddings",
			items: ranked.map((r) => ({ text: r.item.text, score: r.similarity, perf: r.perf })),
			topPerformers: ranked.filter((r) => r.perf != null && r.perf >= TOP_PERFORMER_SCORE).length,
		};
	} catch (err) {
		if (!err.paused) console.error(`[${brand}] Fallback a muestreo al azar (falló la selección por relevancia):`, err.details ?? err);
		return randomReference(brand);
	}
}

// --- Precios por millón de tokens (USD), para estimar costo en el reporte de /usage ---
// Fuente: pricing oficial de Anthropic y Google, revisado en septiembre 2026.
// Si cambian los precios, solo hay que actualizar esta tabla.
const PRICING = {
	"gemini-2.5-flash-lite": { in: 0.10, out: 0.40 },
	"gemini-2.5-flash": { in: 0.30, out: 2.50 },
	"claude-sonnet-5": { in: 2.00, out: 10.00 },
	"claude-haiku-4-5-20251001": { in: 1.00, out: 5.00 },
	"gemini-embedding-001": { in: 0.15, out: 0 },
};

function estimateCostUsd(model, inputTokens, outputTokens) {
	const rate = PRICING[model];
	if (!rate) return null;
	return (inputTokens / 1_000_000) * rate.in + (outputTokens / 1_000_000) * rate.out;
}

// --- Registro de uso: un archivo .jsonl con una línea por llamada a la IA ---
// Sirve para el reporte de /usage (costo real acumulado, no solo estimado).
const USAGE_LOG_PATH = path.join(__dirname, "usage-log.jsonl");

function logUsage({ endpoint, provider, model, inputTokens, outputTokens }) {
	const entry = {
		timestamp: new Date().toISOString(),
		endpoint,
		provider,
		model,
		inputTokens,
		outputTokens,
		estimatedCostUsd: estimateCostUsd(model, inputTokens, outputTokens),
	};
	try {
		fs.appendFileSync(USAGE_LOG_PATH, JSON.stringify(entry) + "\n");
	} catch (err) {
		console.error("No se pudo escribir el log de uso:", err);
	}
	storage.logUsage(entry);
}

// --- Feedback del usuario sobre las opciones que genera la IA (ver /feedback) ---
// "like" = muy buena, "neutral" = buena pero necesita trabajo, "bad" = no se eligió
// (el usuario le dio "intentar de nuevo" sin calificarla, o navegó a otra opción).
const FEEDBACK_LOG_PATH = path.join(__dirname, "feedback-log.jsonl");

function logFeedback({ text, rating, source, brand, original, author, channel, country, clientKey, reasons, comment }) {
	const entry = {
		timestamp: new Date().toISOString(),
		brand,
		source, // "reescribir" o "crear": qué endpoint generó el texto calificado
		rating,
		text,
		original: original ?? null, // el texto original que se pidió reescribir, si aplica
	};
	try {
		fs.appendFileSync(FEEDBACK_LOG_PATH, JSON.stringify(entry) + "\n");
	} catch (err) {
		console.error("No se pudo escribir el log de feedback:", err);
	}
	storage.logFeedback({ text, rating, source, brand, original, author, channel, country, clientKey, reasons, comment });
}

// Un "like" se guarda como nuevo ejemplo de tono para esa marca. No se usa de
// inmediato para elegir referencias por relevancia (eso necesita su embedding,
// que se calcula en el próximo "npm run build-embeddings" / workflow semanal),
// pero sí queda disponible ya mismo para el muestreo al azar de respaldo, y así
// -- poco a poco -- las generaciones futuras se acercan más a lo que sí gustó.
function addLikedTextToTuning(brand, text) {
	const dir = path.join(__dirname, "data", brand);
	const tuningPath = path.join(dir, "tuning.json");

	let existing = [];
	try {
		existing = JSON.parse(fs.readFileSync(tuningPath, "utf-8"));
	} catch {
		existing = [];
	}

	if (existing.some((item) => item.text === text)) return; // ya estaba, no lo dupliques

	existing.push({ url: null, source: "feedback-like", text });
	fs.writeFileSync(tuningPath, JSON.stringify(existing, null, 2));
	brandData[brand] = loadBrandData(brand); // refresca en memoria en esta misma corrida
}

// Llama a Gemini y devuelve { text, usage }. generationConfig es opcional (por
// ejemplo, temperature: 0 para tareas mecánicas donde no queremos variación).
async function callGemini(promptText, model, generationConfig) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_API_KEY}`;

	const response = await fetchWithTimeout(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: promptText }] }],
			...(generationConfig ? { generationConfig } : {}),
		}),
	});

	const data = await parseJsonResponse(response, "Gemini");

	if (data.error) {
		console.error("Error de Gemini:", data.error);
		const error = new Error(data.error.message || "Error de la API de Gemini");
		error.details = data.error;
		throw error;
	}

	const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
	const usage = {
		inputTokens: data?.usageMetadata?.promptTokenCount ?? 0,
		outputTokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
	};

	return { text, usage };
}

// Llama a Claude (Anthropic Messages API) y devuelve { text, usage }. temperature
// es opcional (0 para tareas mecánicas como ortografía, donde no queremos variación).
async function callClaude(promptText, model, { temperature, maxTokens = 1024 } = {}) {
	const response = await fetchWithTimeout(`${ANTHROPIC_API_URL}/v1/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": ANTHROPIC_API_KEY,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model,
			max_tokens: maxTokens,
			// El razonamiento extendido no aporta nada para copy corto y casi duplica
			// el costo de salida (se cobra como output tokens); lo desactivamos.
			thinking: { type: "disabled" },
			...(typeof temperature === "number" ? { temperature } : {}),
			messages: [{ role: "user", content: promptText }],
		}),
	});

	const data = await parseJsonResponse(response, "Claude");

	if (data.error) {
		console.error("Error de Claude:", data.error);
		const error = new Error(data.error.message || "Error de la API de Claude");
		error.details = data.error;
		throw error;
	}

	// El primer bloque no siempre es el de texto (puede venir un bloque "thinking"
	// antes), así que se busca el bloque de tipo "text" en vez de asumir índice 0.
	const textBlock = (data?.content || []).find((block) => block.type === "text");
	const text = textBlock?.text || "";
	const usage = {
		inputTokens: data?.usage?.input_tokens ?? 0,
		outputTokens: data?.usage?.output_tokens ?? 0,
	};

	return { text, usage };
}

// Valida que el body traiga "prompt" como texto no vacío antes de gastar una llamada a la IA
function requirePrompt(req, res) {
	const { prompt } = req.body ?? {};
	if (typeof prompt !== "string" || prompt.trim().length === 0) {
		res.status(400).json({ error: "Falta el campo 'prompt' (texto) en el body." });
		return null;
	}
	return prompt;
}

// Lógica de /ortografia separada del handler HTTP para reusarla desde el bot de Slack.
async function ortografiaCore({ prompt, brand }) {
	const fullPrompt = `Eres un corrector ortográfico de textos en español para redes sociales y anuncios de ${BRANDS[brand].label}. El texto siempre debe tratar al lector de "tú", nunca de "vos" -- ninguna de nuestras marcas usa voseo.

Corrige estos errores:
- Ortografía, tildes faltantes o de más, letras repetidas o cambiadas de lugar, y errores de tipeo. Revisa con cuidado las tildes obligatorias (cómo, estás, está, qué, más, así, etc.) -- es el error más común y el que más se pasa por alto.
- Cualquier forma de voseo (comprá, tenés, sabés, vení, "vos") -- conviértelo siempre a la forma con "tú" (compra, tienes, sabes, ven). Para esta marca el voseo es un error, no una variante regional válida.

No cambies nada más que eso: conserva el vocabulario, el tono y la puntuación. No agregues ni quites palabras, no reformules.

Responde ÚNICAMENTE con el texto corregido, sin comillas ni explicación.

Texto:
${prompt}`;
	const { text: correctedText, usage } = await callClaude(fullPrompt, CLAUDE_MODEL_ORTOGRAFIA, {
		temperature: 0,
	});
	logUsage({
		endpoint: "/ortografia",
		provider: "claude",
		model: CLAUDE_MODEL_ORTOGRAFIA,
		...usage,
	});
	return correctedText;
}

app.post("/ortografia", async (req, res) => {
	if (requireAuth(req, res) === null) return;
	const prompt = requirePrompt(req, res);
	if (prompt === null) return;
	const brand = resolveBrand(req, res);
	if (brand === null) return;

	try {
		const correctedText = await ortografiaCore({ prompt, brand });
		res.json({ correctedText });
	} catch (err) {
		respondWithError(res, err, "/ortografia");
	}
});

// --- Motor de copy compartido por /reescribir, /generate y Slack ---
// Pide la respuesta en JSON (ver copy-engine.mjs), mide cada campo contra el
// límite del formato y, si alguna opción se pasa, pide UNA versión recortada
// solo de esas. Devuelve { raw, options, references }:
//   raw        -> lista "* opción" (compatibilidad con el plugin actual)
//   options    -> [{ text, angle, angleLabel, fields:[{label,value,length,max,ok}], ok }]
//   references -> { method, count, top } para mostrar "inspirado en…"
async function runCopy({ mode, prompt, brand, format }) {
	const endpoint = mode === "reescribir" ? "/reescribir" : "/generate";
	const model = mode === "reescribir" ? CLAUDE_MODEL_REESCRIBIR : CLAUDE_MODEL_GENERATE;
	const formatDef = FORMATS[format];
	const angles = mode === "crear"; // reescribir conserva el mensaje original; crear explora ángulos

	const reference = await buildRelevantReference(prompt, endpoint, brand);
	const formatGuidance = formatDef.guidance ? `\nFormato de destino: ${formatDef.label}. ${formatDef.guidance}\n` : "";
	const task =
		mode === "reescribir"
			? `Ahora, con base en ese estilo, reescribe el siguiente texto para que se ajuste a mi voz y tono, conservando lo que dice:\n${prompt}`
			: `Ahora, con base en ese estilo, responde a esta petición:\n${prompt}`;
	const fullPrompt = `
Eres un asistente que debe crear textos publicitarios (copy) respetando mi voz y tono.
Aquí tienes ejemplos de mi estilo extraídos de la web e instagram, elegidos por ser los más
parecidos en tema a ${mode === "reescribir" ? "el texto que me pediste reescribir" : "lo que me pediste"}:

${reference.text}
${reference.topPerformers ? `\nLos marcados con ★ fueron los de MEJOR desempeño real en anuncios (más clics y mejor costo por compra): dales más peso a su estructura, arranque y llamado a la acción.\n` : ""}${formatGuidance}${storage.glossaryPrompt(brand)}${lessonsPrompt(brand)}${dislikesPrompt(brand)}
${task}
${outputInstructions({ formatDef, angles })}
`;
	const { text, usage } = await callClaude(fullPrompt, model);
	logUsage({ endpoint, provider: "claude", model, ...usage });

	let options = parseCopyResponse(text, formatDef).map((o) => checkOption(o, formatDef));

	// Reintento automático solo para las opciones que se pasaron del límite.
	const failingIdx = options.map((o, i) => (o.ok ? -1 : i)).filter((i) => i >= 0);
	if (failingIdx.length) {
		try {
			const { text: fixedText, usage: fixUsage } = await callClaude(
				shortenPrompt({ failing: failingIdx.map((i) => options[i]), formatDef, angles }),
				model,
			);
			logUsage({ endpoint: `${endpoint}:recorte`, provider: "claude", model, ...fixUsage });
			const fixed = parseCopyResponse(fixedText, formatDef).map((o) => checkOption(o, formatDef));
			const totalLen = (o) => o.fields.reduce((n, f) => n + f.length, 0);
			failingIdx.forEach((optIdx, k) => {
				const candidate = fixed[k];
				// Solo reemplaza si la versión recortada cumple o al menos quedó más corta.
				if (candidate && (candidate.ok || totalLen(candidate) < totalLen(options[optIdx]))) {
					options[optIdx] = { ...candidate, angle: candidate.angle || options[optIdx].angle };
				}
			});
		} catch (err) {
			console.error(`[${endpoint}] No se pudo recortar:`, err.details ?? err);
		}
	}

	const final = options.map((o) => ({
		text: optionText(o, formatDef),
		angle: o.angle,
		angleLabel: o.angle ? ANGLES[o.angle] : null,
		fields: o.fields,
		ok: o.ok,
	}));
	return {
		raw: toLegacyList(final),
		options: final,
		references: {
			method: reference.method,
			count: reference.items.length,
			topPerformers: reference.topPerformers || 0,
			top: reference.items[0]?.text?.slice(0, 160) || null,
		},
	};
}

const reescribirCore = ({ prompt, brand, format }) => runCopy({ mode: "reescribir", prompt, brand, format });

// --- Copy desde imagen (Slack) ---
// 1) Claude con visión lee la imagen: ¿es una pieza de la marca casi final o una
//    referencia (competencia/inspiración)?, qué textos trae y qué corregir en ellos.
// 2) Con esa lectura se arma una petición normal de "crear" (runCopy), así hereda
//    referencias ★, glosario, 👎, límites por formato y botones.
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
async function imageCopyCore({ image, note = "", brand, format }) {
	if (!IMAGE_MEDIA_TYPES.includes(image.mediaType)) throw new Error("Formato de imagen no soportado");
	const brandName = BRANDS[brand].label;
	const visionPrompt = `Eres el revisor de copy de ${brandName} (ópticas, México).
Analiza la imagen adjunta.${note ? ` La persona escribió: "${note}".` : ""}
${storage.glossaryPrompt(brand)}
Responde ÚNICAMENTE con un JSON válido, sin markdown:
{"tipo":"pieza"|"referencia","descripcion":"...","textos_en_imagen":["..."],"revision":[{"texto":"...","problema":"...","sugerencia":"..."}]}
- "tipo": "pieza" si es un diseño/post/banner de ${brandName} (logo, estilo o producto de la marca) casi listo; "referencia" si es de otra marca (competencia o inspiración). Si la persona lo dice, hazle caso.
- "descripcion": 2-3 frases concretas de lo que se ve y comunica (producto, colores, mensaje, promo, público).
- "textos_en_imagen": los textos visibles, tal cual, en orden de lectura (vacío si no hay).
- "revision": SOLO si tipo = "pieza": errores de ortografía, tildes, puntuación, palabras prohibidas del glosario o frases que no suenan a la marca. Vacío si todo está bien. No inventes problemas.`;
	const { text: raw, usage } = await callClaude(
		[
			{ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
			{ type: "text", text: visionPrompt },
		],
		CLAUDE_MODEL_GENERATE,
		{ maxTokens: 1200 },
	);
	logUsage({ endpoint: "/slack:imagen", provider: "claude", model: CLAUDE_MODEL_GENERATE, ...usage });

	let info = { tipo: "pieza", descripcion: "", textos_en_imagen: [], revision: [] };
	try {
		const clean = raw.replace(/```(?:json)?/gi, "");
		info = { ...info, ...JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)) };
	} catch {
		info.descripcion = raw.slice(0, 600);
	}
	const textos = (info.textos_en_imagen || []).filter(Boolean).slice(0, 12);
	const prompt =
		info.tipo === "referencia"
			? `Adapta al tono de ${brandName} esta referencia (un anuncio de otra marca). Toma la idea, estructura o gancho, pero NO copies frases textuales ni menciones a la otra marca.
Qué se ve: ${info.descripcion}
${textos.length ? `Textos de la referencia: ${textos.map((t) => `"${t}"`).join(" / ")}` : ""}
${note ? `Petición: ${note}` : ""}`
			: `Escribe el copy que acompaña esta pieza de ${brandName} (caption/texto del anuncio). Complementa lo que ya dice la imagen; no repitas literal sus textos.
Qué se ve: ${info.descripcion}
${textos.length ? `Textos en la imagen: ${textos.map((t) => `"${t}"`).join(" / ")}` : ""}
${note ? `Petición: ${note}` : ""}`;
	const result = await runCopy({ mode: "crear", prompt: prompt.trim(), brand, format });
	return {
		...result,
		prompt: prompt.trim(), // para "Otra tanda" sin volver a mandar la imagen
		image: {
			tipo: info.tipo === "referencia" ? "referencia" : "pieza",
			descripcion: info.descripcion || "",
			textos,
			revision: (info.revision || []).filter((r) => r && r.texto).slice(0, 8),
		},
	};
}
const generateCore = ({ prompt, brand, format }) => runCopy({ mode: "crear", prompt, brand, format });


app.post("/reescribir", async (req, res) => {
	if (requireAuth(req, res) === null) return;
	const prompt = requirePrompt(req, res);
	if (prompt === null) return;
	const brand = resolveBrand(req, res);
	if (brand === null) return;
	const format = resolveFormat(req.body?.format);

	try {
		const result = await reescribirCore({ prompt, brand, format });
		res.json({ correctedText: result.raw, options: result.options, references: result.references });
	} catch (err) {
		respondWithError(res, err, "/reescribir");
	}
});

app.post("/generate", async (req, res) => {
	if (requireAuth(req, res) === null) return;
	const prompt = requirePrompt(req, res);
	if (prompt === null) return;
	const brand = resolveBrand(req, res);
	if (brand === null) return;
	const format = resolveFormat(req.body?.format);

	try {
		const result = await generateCore({ prompt, brand, format });
		res.json({ text: result.raw, options: result.options, references: result.references });
	} catch (err) {
		respondWithError(res, err, "/generate");
	}
});

// El plugin manda esto cuando el usuario califica una opción generada por IA
// (👍 muy buena, ⚪ buena pero necesita trabajo), o automáticamente con rating
// "bad" cuando el usuario le da "intentar de nuevo" sin haber calificado ni
// aplicado alguna de las opciones mostradas -- se asume que esas no sirvieron.
// Guarda una calificación (log + tuning si es 👍). Usada por /feedback y por Slack.
function saveFeedback({ text, rating, source, brand, original, author, channel, country, clientKey, reasons, comment }) {
	reasons = cleanReasons(reasons);
	comment = String(comment || "").trim().slice(0, 1000);
	logFeedback({ text, rating, source: source || "desconocido", brand, original, author, channel, country, clientKey, reasons, comment });
	if (rating === "like") {
		addLikedTextToTuning(brand, text);
	}
	if (rating === "bad" && String(source || "").endsWith("-explicito") && text) {
		dislikesByBrand[brand] = [{ text, reasons, comment }, ...(dislikesByBrand[brand] || []).filter((d) => d.text !== text)].slice(
			0,
			DISLIKES_IN_PROMPT * 2,
		);
	}
	if ((rating === "bad" || rating === "neutral") && (reasons.length || comment)) {
		(lessonsByBrand[brand] ||= []).unshift({ rating, text, reasons, comment, country });
	}
}

// Motivo opcional que llega DESPUÉS de la calificación (modal de Slack / formulario del plugin).
async function saveFeedbackDetail({ clientKey, author, brand, text, rating, reasons, comment }) {
	reasons = cleanReasons(reasons);
	comment = String(comment || "").trim().slice(0, 1000);
	if (!clientKey || (!reasons.length && !comment)) return false;
	await storage.updateFeedbackDetail({ clientKey, author, reasons, comment });
	if (brand && BRANDS[brand]) {
		(lessonsByBrand[brand] ||= []).unshift({ rating, text, reasons, comment });
		const d = (dislikesByBrand[brand] || []).find((x) => x.text === text);
		if (d) Object.assign(d, { reasons, comment });
	}
	return true;
}

// Motivo opcional de un ⚪/👎 ya enviado: { clientKey, reasons: ["largo",...], comment, text, rating }.
app.post("/feedback/detail", async (req, res) => {
	const session = requireAuth(req, res);
	if (session === null) return;
	const { clientKey, reasons, comment, text, rating } = req.body ?? {};
	if (typeof clientKey !== "string" || !clientKey) return res.status(400).json({ error: "Falta clientKey." });
	const brand = BRANDS[req.body?.brand] ? req.body.brand : DEFAULT_BRAND;
	try {
		const ok = await saveFeedbackDetail({ clientKey: clientKey.slice(0, 64), author: session.email, brand, text, rating, reasons, comment });
		res.json({ ok });
	} catch (err) {
		console.error("[/feedback/detail] Error:", err.message);
		res.status(500).json({ error: "No se pudo guardar el motivo." });
	}
});

app.post("/feedback", (req, res) => {
	const session = requireAuth(req, res);
	if (session === null) return;
	const { text, rating, source, original } = req.body ?? {};

	if (typeof text !== "string" || text.trim().length === 0) {
		return res.status(400).json({ error: "Falta el campo 'text' (texto) en el body." });
	}
	if (!["like", "neutral", "bad"].includes(rating)) {
		return res.status(400).json({ error: "El campo 'rating' debe ser 'like', 'neutral' o 'bad'." });
	}

	const brand = BRANDS[req.body?.brand] ? req.body.brand : DEFAULT_BRAND;

	const { clientKey, reasons, comment, explicit, country } = req.body ?? {};
	try {
		saveFeedback({
			text,
			rating,
			// 👎 del botón (explícito) vs "bad" automático de pedir otra tanda.
			source: rating === "bad" && explicit ? `${source || "desconocido"}-explicito` : source,
			brand,
			original,
			author: session.email,
			channel: "figma",
			country: typeof country === "string" ? country.slice(0, 2) : null,
			clientKey: typeof clientKey === "string" ? clientKey.slice(0, 64) : null,
			reasons,
			comment,
		});
		res.json({ ok: true });
	} catch (err) {
		console.error("[/feedback] Error:", err);
		res.status(500).json({ error: "No se pudo guardar el feedback." });
	}
});

app.post("/test", (req, res) => {
	const brand = resolveBrand(req, res);
	if (brand === null) return;
	const text = buildStyleReference(brand);
	res.json({ message: text, height: text.length });
});

// Marcas disponibles, para que el plugin arme el switch sin hardcodearlas.
app.get("/brands", (req, res) => {
	const brands = Object.entries(BRANDS).map(([key, { label }]) => ({
		key,
		label,
		referenceCount: brandData[key].referenceData.length,
	}));
	res.json({ brands, default: DEFAULT_BRAND });
});

// Reporte de uso y costo estimado, para decidir si el gasto en IA es viable.
// GET /usage  -> totales generales
// GET /usage?days=7 -> solo los últimos N días
async function computeUsageSummary(days) {
	let lines = [];
	const fromDb = await storage.loadUsage(days).catch((err) => {
		console.error("[storage]", err.message);
		return null;
	});
	if (fromDb) {
		lines = fromDb;
		days = 0; // ya viene filtrado por fecha
	} else try {
		lines = fs
			.readFileSync(USAGE_LOG_PATH, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		lines = []; // aún no hay llamadas registradas
	}

	days = Number(days);
	if (Number.isFinite(days) && days > 0) {
		const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
		lines = lines.filter((l) => new Date(l.timestamp).getTime() >= cutoff);
	}

	const summary = {
		requests: lines.length,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalEstimatedCostUsd: 0,
		byEndpoint: {},
		byProvider: {},
	};

	for (const l of lines) {
		summary.totalInputTokens += l.inputTokens || 0;
		summary.totalOutputTokens += l.outputTokens || 0;
		summary.totalEstimatedCostUsd += l.estimatedCostUsd || 0;

		summary.byEndpoint[l.endpoint] ??= { requests: 0, estimatedCostUsd: 0 };
		summary.byEndpoint[l.endpoint].requests += 1;
		summary.byEndpoint[l.endpoint].estimatedCostUsd += l.estimatedCostUsd || 0;

		summary.byProvider[l.provider] ??= { requests: 0, estimatedCostUsd: 0 };
		summary.byProvider[l.provider].requests += 1;
		summary.byProvider[l.provider].estimatedCostUsd += l.estimatedCostUsd || 0;
	}

	summary.totalEstimatedCostUsd = Number(summary.totalEstimatedCostUsd.toFixed(6));
	for (const k of Object.keys(summary.byEndpoint)) {
		summary.byEndpoint[k].estimatedCostUsd = Number(summary.byEndpoint[k].estimatedCostUsd.toFixed(6));
	}
	for (const k of Object.keys(summary.byProvider)) {
		summary.byProvider[k].estimatedCostUsd = Number(summary.byProvider[k].estimatedCostUsd.toFixed(6));
	}

	return summary;
}

app.get("/usage", async (req, res) => {
	res.json(await computeUsageSummary(req.query.days));
});

// Reporte de las calificaciones que ha ido dejando el equipo sobre las opciones
// generadas -- para ver, marca por marca, qué tanto está sirviendo la IA.
// GET /feedback-summary  -> totales generales
// GET /feedback-summary?brand=benandfrank -> solo esa marca
async function computeFeedbackSummary(brandFilter) {
	let lines = [];
	const fromDb = await storage.loadFeedback(brandFilter).catch((err) => {
		console.error("[storage]", err.message);
		return null;
	});
	if (fromDb) lines = fromDb;
	else try {
		lines = fs
			.readFileSync(FEEDBACK_LOG_PATH, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		lines = []; // aún no hay feedback registrado
	}

	if (brandFilter) {
		lines = lines.filter((l) => l.brand === brandFilter);
	}

	const summary = { total: lines.length, byBrand: {}, bySource: {} };

	for (const l of lines) {
		summary.byBrand[l.brand] ??= { like: 0, neutral: 0, bad: 0 };
		summary.byBrand[l.brand][l.rating] = (summary.byBrand[l.brand][l.rating] || 0) + 1;

		summary.bySource[l.source] ??= { like: 0, neutral: 0, bad: 0 };
		summary.bySource[l.source][l.rating] = (summary.bySource[l.source][l.rating] || 0) + 1;
	}

	return summary;
}

app.get("/feedback-summary", async (req, res) => {
	res.json(await computeFeedbackSummary(req.query.brand));
});

// Mini-dashboard visual de /usage y /feedback-summary (para no tener que leer
// JSON crudo). Es un archivo estático que hace fetch a esos mismos endpoints
// desde el navegador, así que no necesita nada extra del server.
app.get("/dashboard", (req, res) => {
	res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// --- Fase 3: bandeja "Mandar a Figma" (lo que alguien elige en Slack) ---
// El plugin pregunta por los textos pendientes del correo con el que inició
// sesión. Requiere el login con Google (sin sesión no hay a quién emparejar).
app.get("/figma-inbox", async (req, res) => {
	const session = requireAuth(req, res);
	if (session === null) return;
	if (!session.email) return res.json({ items: [] });
	try {
		res.json({ items: await storage.listFigmaInbox(session.email) });
	} catch (err) {
		console.error("[/figma-inbox]", err.message);
		res.status(500).json({ error: "No se pudo leer la bandeja." });
	}
});

app.post("/figma-inbox/consume", async (req, res) => {
	const session = requireAuth(req, res);
	if (session === null) return;
	if (!session.email || !req.body?.id) return res.status(400).json({ error: "Falta id." });
	try {
		await storage.consumeFigmaInbox(session.email, req.body.id);
		res.json({ ok: true });
	} catch (err) {
		console.error("[/figma-inbox/consume]", err.message);
		res.status(500).json({ error: "No se pudo actualizar la bandeja." });
	}
});

// --- Fase 3: endpoints servidor-a-servidor (menú de Google Sheets y cron) ---
// Protegidos con el mismo secreto compartido del puente de Sheets
// (TOPITO_SHEET_SECRET), en el header X-Topito-Secret.
function requireInternalSecret(req, res) {
	const secret = process.env.TOPITO_SHEET_SECRET;
	const given = String(req.headers["x-topito-secret"] || "");
	const ok =
		secret && given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
	if (!ok) res.status(401).json({ error: "unauthorized" });
	return ok;
}

// Copy desde imagen para integraciones internas (mismo motor que Slack).
// Body: { image: <base64>, mediaType: "image/png", note?, brand?, format? }
app.post("/internal/image-copy", async (req, res) => {
	if (!requireInternalSecret(req, res)) return;
	const brand = BRANDS[req.body?.brand] ? req.body.brand : DEFAULT_BRAND;
	const format = FORMATS[req.body?.format] ? req.body.format : "general";
	try {
		const out = await imageCopyCore({
			image: { data: String(req.body?.image || ""), mediaType: req.body?.mediaType || "image/png" },
			note: String(req.body?.note || ""),
			brand,
			format,
		});
		res.json(out);
	} catch (err) {
		respondWithError(res, err, "/internal/image-copy");
	}
});

// Una fila de la pestaña "Lote" del Sheet de Topito → opciones de copy.
app.post("/sheets/copy", async (req, res) => {
	if (!requireInternalSecret(req, res)) return;
	const { action = "crear", text, brand: rawBrand, format: rawFormat } = req.body ?? {};
	if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Falta 'text'." });
	const brand = BRANDS[rawBrand] ? rawBrand : DEFAULT_BRAND;
	const format = resolveFormat(rawFormat);
	try {
		if (action === "ortografia") {
			const corrected = await ortografiaCore({ prompt: text, brand });
			return res.json({ options: [{ text: corrected, ok: true, fields: [] }] });
		}
		const result = action === "reescribir"
			? await reescribirCore({ prompt: text, brand, format })
			: await generateCore({ prompt: text, brand, format });
		res.json({ options: result.options, references: result.references });
	} catch (err) {
		respondWithError(res, err, "/sheets/copy");
	}
});

// --- Bot de Slack (asistente de copy) ---
// Se activa solo si SLACK_BOT_TOKEN y SLACK_SIGNING_SECRET están configurados;
// si no, estas rutas responden 503 y el resto del server sigue igual.
registerSlackRoutes(app, {
	BRANDS,
	DEFAULT_BRAND,
	FORMATS,
	ALLOWED_EMAIL_DOMAIN,
	ANTHROPIC_API_KEY,
	fetchWithTimeout,
	parseJsonResponse,
	logUsage,
	ortografiaCore,
	reescribirCore,
	generateCore,
	imageCopyCore,
	saveFeedback,
	saveFeedbackDetail,
	FEEDBACK_REASONS,
	computeUsageSummary,
	computeFeedbackSummary,
	storage,
	requireInternalSecret,
	knowledgeStats: () =>
		Object.fromEntries(
			Object.keys(BRANDS).map((b) => [
				b,
				{
					examples: brandData[b].referenceData.length,
					embeddings: brandData[b].referenceEmbeddings?.length || 0,
					withPerformance: brandData[b].performance?.size || 0,
					topPerformers: [...(brandData[b].performance?.values() || [])].filter((i) => i.score >= TOP_PERFORMER_SCORE).length,
				},
			]),
		),
	// Copys de Topito detectados en anuncios reales (scripts/fetch-ad-performance.mjs).
	topitoPublished: () => {
		try {
			return JSON.parse(fs.readFileSync(path.join(__dirname, "data", "topito-published.json"), "utf-8"));
		} catch {
			return null;
		}
	},
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
