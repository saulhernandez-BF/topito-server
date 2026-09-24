// =============================================================================
// Topito para Slack — asistente de copy que usa los mismos servicios del plugin
// (ortografía, reescribir, crear, feedback y reporte de uso).
//
// Cómo se usa desde Slack:
//   • Mencionando al bot en un canal:  @Topito escribe 3 headlines para lentes de sol
//   • Por DM al bot, en lenguaje natural: "revisa la ortografía de: ..."
//   • Atajo sobre cualquier mensaje (⋯ → "Reescribir con Topito" / "Revisar ortografía")
//
// Flujo técnico:
//   1. Slack manda el evento a POST /slack/events (o la interacción a
//      POST /slack/interactions). Verificamos la firma HMAC y respondemos 200
//      de inmediato (Slack exige respuesta en < 3 s).
//   2. En segundo plano, un "router" barato (Claude Haiku con tool-use) entiende
//      qué pidió la persona: acción, marca, formato y el texto a procesar —
//      usando el hilo como contexto ("hazlo más corto", "ahora para Bombavista").
//   3. Se llama a la MISMA lógica que usa el plugin (ortografiaCore,
//      reescribirCore, generateCore) y se responde en el hilo con botones de
//      👍 / ⚪ / Otra tanda. Los 👍 alimentan data/<marca>/tuning.json igual que
//      en Figma.
//
// Seguridad:
//   • Firma de Slack verificada en cada request (SLACK_SIGNING_SECRET) con
//     protección contra replay (> 5 min se rechaza).
//   • Solo usuarios con correo @ALLOWED_EMAIL_DOMAIN (scope users:read.email).
//   • Opcional: SLACK_ALLOWED_TEAM_ID para aceptar solo el workspace de B&F.
//   • Opcional: SLACK_ADMIN_USER_IDS para limitar quién ve costos.
//   • Anti-bucles: se ignoran mensajes de bots (incluido el propio), ediciones
//     y reintentos de Slack; además hay deduplicación por event_id.
//   • Límite por usuario (SLACK_RATE_LIMIT por 10 min) para cuidar la cuota de IA.
// =============================================================================

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFS_PATH = path.join(__dirname, "data", "slack-prefs.json");

export function registerSlackRoutes(app, deps) {
	const {
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
		saveFeedback,
		computeUsageSummary,
		computeFeedbackSummary,
		storage,
		requireInternalSecret,
		knowledgeStats,
		topitoPublished,
	} = deps;

	const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
	const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
	const ENABLED = Boolean(BOT_TOKEN && SIGNING_SECRET);
	const ROUTER_MODEL = process.env.CLAUDE_MODEL_SLACK_ROUTER || "claude-haiku-4-5-20251001";
	const ALLOWED_TEAM_ID = process.env.SLACK_ALLOWED_TEAM_ID || null;
	const ADMIN_IDS = (process.env.SLACK_ADMIN_USER_IDS || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const RATE_LIMIT = Number(process.env.SLACK_RATE_LIMIT) || 30; // peticiones de IA por usuario cada 10 min
	const RATE_WINDOW_MS = 10 * 60 * 1000;

	const ACTION_LABELS = {
		crear: "✍️ Crear",
		reescribir: "🔁 Reescribir",
		ortografia: "🔤 Ortografía",
	};

	if (!ENABLED) {
		console.log("[slack] Bot desactivado: faltan SLACK_BOT_TOKEN y/o SLACK_SIGNING_SECRET.");
		const off = (req, res) => res.status(503).json({ error: "El bot de Slack no está configurado." });
		app.post("/slack/events", off);
		app.post("/slack/interactions", off);
		return;
	}
	console.log("[slack] Bot activo en /slack/events y /slack/interactions");

	// ---------------------------------------------------------------------------
	// Utilidades generales
	// ---------------------------------------------------------------------------

	// Verificación oficial de Slack: HMAC-SHA256 de "v0:<timestamp>:<body crudo>".
	function verifySlackSignature(req) {
		const ts = req.headers["x-slack-request-timestamp"];
		const sig = req.headers["x-slack-signature"];
		if (!ts || !sig || typeof req.rawBody !== "string") return false;
		if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false; // anti-replay
		const expected = "v0=" + crypto.createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${req.rawBody}`).digest("hex");
		const a = Buffer.from(expected);
		const b = Buffer.from(String(sig));
		return a.length === b.length && crypto.timingSafeEqual(a, b);
	}

	// Cache simple con expiración (dedupe de eventos, emails verificados, etc.)
	function ttlCache(ttlMs) {
		const map = new Map();
		return {
			get(k) {
				const hit = map.get(k);
				if (!hit) return undefined;
				if (Date.now() > hit.exp) {
					map.delete(k);
					return undefined;
				}
				return hit.v;
			},
			set(k, v) {
				map.set(k, { v, exp: Date.now() + ttlMs });
				if (map.size > 5000) map.delete(map.keys().next().value);
			},
		};
	}
	const seenEvents = ttlCache(10 * 60 * 1000);
	const userAuthCache = ttlCache(60 * 60 * 1000);
	const rateBuckets = new Map();

	function checkRateLimit(userId) {
		const now = Date.now();
		const hits = (rateBuckets.get(userId) || []).filter((t) => now - t < RATE_WINDOW_MS);
		if (hits.length >= RATE_LIMIT) {
			rateBuckets.set(userId, hits);
			return false;
		}
		hits.push(now);
		rateBuckets.set(userId, hits);
		return true;
	}

	// Slack mrkdwn requiere escapar &, < y >.
	const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

	// Preferencia de marca por usuario (se recuerda entre conversaciones).
	let prefs = {};
	try {
		prefs = JSON.parse(fs.readFileSync(PREFS_PATH, "utf-8"));
	} catch {
		prefs = {};
	}
	// Supabase es la fuente de verdad; el archivo local queda como respaldo.
	storage?.loadSlackPrefs?.().then((fromDb) => {
		if (fromDb) prefs = { ...prefs, ...fromDb };
	});
	const getBrand = (userId) => (BRANDS[prefs[userId]?.brand] ? prefs[userId].brand : DEFAULT_BRAND);
	function setBrand(userId, brand) {
		if (!BRANDS[brand] || prefs[userId]?.brand === brand) return;
		prefs[userId] = { ...(prefs[userId] || {}), brand };
		storage?.saveSlackPref?.(userId, brand);
		try {
			fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
			fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
		} catch (err) {
			console.error("[slack] No se pudo guardar slack-prefs.json:", err);
		}
	}

	// ---------------------------------------------------------------------------
	// Cliente mínimo de la Web API de Slack (sin dependencias extra)
	// ---------------------------------------------------------------------------
	async function slack(method, params = {}) {
		const form = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) {
			if (v === undefined || v === null) continue;
			form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
		}
		const response = await fetchWithTimeout(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
				Authorization: `Bearer ${BOT_TOKEN}`,
			},
			body: form.toString(),
		});
		const data = await parseJsonResponse(response, "Slack");
		if (!data.ok) {
			const err = new Error(`Slack ${method}: ${data.error}`);
			err.details = { slackError: data.error, method };
			throw err;
		}
		return data;
	}

	async function postToResponseUrl(url, body) {
		await fetchWithTimeout(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	let botUserIdPromise = null;
	const getBotUserId = () => (botUserIdPromise ??= slack("auth.test").then((d) => d.user_id).catch(() => null));

	// Solo gente del dominio permitido (misma regla que el login de Google del plugin).
	const userEmails = new Map();
	const getUserEmail = (userId) => userEmails.get(userId) || null;

	async function isAllowedUser(userId) {
		const cached = userAuthCache.get(userId);
		if (cached !== undefined) return cached;
		let ok = false;
		try {
			const { user } = await slack("users.info", { user: userId });
			const email = (user?.profile?.email || "").toLowerCase();
			ok = !user?.is_bot && !user?.deleted && email.endsWith("@" + ALLOWED_EMAIL_DOMAIN.toLowerCase());
			if (ok) userEmails.set(userId, email);
		} catch (err) {
			console.error("[slack] users.info falló:", err.details ?? err);
		}
		userAuthCache.set(userId, ok);
		return ok;
	}

	// ---------------------------------------------------------------------------
	// Router: entiende la petición en lenguaje natural (Claude Haiku + tool-use)
	// ---------------------------------------------------------------------------
	const ROUTER_TOOL = {
		name: "ejecutar_accion",
		description: "Decide qué servicio de Topito ejecutar para la petición del usuario.",
		input_schema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["crear", "reescribir", "ortografia", "lote", "reporte_uso", "ayuda", "responder"],
					description:
						"crear = generar copy nuevo desde una instrucción o brief (también para ajustar/iterar un copy anterior: 'más corto', 'con emoji'); reescribir = el usuario da un texto existente y quiere que se reescriba con el tono de la marca; ortografia = corregir solo ortografía/tildes de un texto; lote = el mensaje trae el contenido de un documento con una LISTA de copies ya escritos que hay que entonar/reescribir uno por uno (usa el campo items); reporte_uso = costos/uso/calificaciones del servicio; ayuda = qué puede hacer Topito; responder = cualquier otra cosa (saludo, pregunta corta).",
				},
				text: {
					type: "string",
					description:
						"El texto a procesar, AUTOCONTENIDO. Para crear: la instrucción/brief completa, incluyendo el copy anterior del hilo si el usuario pide ajustarlo (ej. 'Toma este copy: \"...\" y hazlo más corto'). Para reescribir/ortografia: solo el texto original exacto, sin la instrucción.",
				},
				brand: {
					type: "string",
					enum: Object.keys(BRANDS),
					description: "Marca. Solo si el usuario la menciona o el hilo la deja clara; si no, omítela.",
				},
				format: {
					type: "string",
					enum: Object.keys(FORMATS),
					description:
						"Canal: headline = título/headline de anuncio de Meta; primario = texto primario/cuerpo de anuncio (Meta/IG ads); caption = post o caption de redes sociales (RRSS, IG); web = copy de sitio/landing; email = asunto y preheader de email/newsletter; google_ads = anuncio de Google/búsqueda (título + descripción); hook = gancho/primeros segundos de video TikTok/Reels; cta = texto de botón o llamado a la acción; general = no está claro.",
				},
				items: {
					type: "array",
					items: { type: "string" },
					description: "Para lote: cada copy de la lista, tal cual aparece en el documento (máximo 10, sin encabezados ni notas).",
				},
				days: { type: "integer", description: "Para reporte_uso: días hacia atrás (opcional)." },
				reply: {
					type: "string",
					description: "Para ayuda/responder: respuesta breve en español, tono cercano, tratando de 'tú'.",
				},
			},
			required: ["action"],
		},
	};

	async function routeRequest({ message, history, currentBrand }) {
		const brandList = Object.entries(BRANDS)
			.map(([k, v]) => `${k} (${v.label})`)
			.join(", ");
		const system = `Eres el router de "Topito", el asistente de copy del equipo de Ben & Frank / Bombavista en Slack.
Topito puede: crear copy nuevo, reescribir un texto con el tono de marca, corregir ortografía y mostrar un reporte de uso/costos.
Marcas: ${brandList}. Marca activa del usuario: ${currentBrand}.
Siempre llama a la herramienta ejecutar_accion. Si el usuario pega un texto y pide "mejorarlo", "pasarlo a nuestro tono" o similar, es reescribir. Si pide ideas, opciones, headlines, captions, etc., es crear. Si en el hilo ya hay opciones de Topito y el usuario pide un ajuste, usa crear e incluye el copy de referencia en "text".
Si el mensaje incluye "[Contenido del documento]": si es una lista de copies ya escritos para entonar o revisar, usa lote con "items"; si pide revisar ortografía de la lista, usa ortografia con todo el texto; si es un brief (objetivo, producto, público, mensajes clave), usa crear y pon en "text" el brief resumido junto con lo que pidió el usuario.`;
		const convo = history.length
			? `Contexto del hilo (más antiguo primero):\n${history.join("\n")}\n\nMensaje nuevo del usuario:\n${message}`
			: message;

		const response = await fetchWithTimeout(`${(process.env.ANTHROPIC_API_URL || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": ANTHROPIC_API_KEY,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: ROUTER_MODEL,
				max_tokens: 2048,
				temperature: 0,
				system,
				tools: [ROUTER_TOOL],
				tool_choice: { type: "tool", name: ROUTER_TOOL.name },
				messages: [{ role: "user", content: convo }],
			}),
		});
		const data = await parseJsonResponse(response, "Claude");
		if (data.error) {
			const err = new Error(data.error.message || "Error de Claude (router)");
			err.details = data.error;
			throw err;
		}
		logUsage({
			endpoint: "slack/router",
			provider: "claude",
			model: ROUTER_MODEL,
			inputTokens: data?.usage?.input_tokens ?? 0,
			outputTokens: data?.usage?.output_tokens ?? 0,
		});
		const toolUse = (data.content || []).find((b) => b.type === "tool_use");
		return toolUse?.input || { action: "ayuda" };
	}

	// ---------------------------------------------------------------------------
	// Ejecución de acciones (reusa la lógica del plugin)
	// ---------------------------------------------------------------------------

	async function runCopyAction({ action, text, brand, format }) {
		if (action === "ortografia") {
			return { corrected: await ortografiaCore({ prompt: text, brand }) };
		}
		const result =
			action === "reescribir"
				? await reescribirCore({ prompt: text, brand, format })
				: await generateCore({ prompt: text, brand, format });
		return { options: result.options, references: result.references };
	}

	function friendlyError(err) {
		const d = err?.details || {};
		if (d.code === 429 || d.code === 503 || d.type === "rate_limit_error" || d.type === "overloaded_error") {
			return "😮‍💨 La IA está saturada en este momento. Intenta de nuevo en unos segundos.";
		}
		if (d.message === "timeout") return "⏱️ La IA tardó demasiado en responder. Intenta de nuevo.";
		return "😕 Algo salió mal al procesar tu petición. Intenta de nuevo en un momento.";
	}

	// ---------------------------------------------------------------------------
	// Block Kit
	// ---------------------------------------------------------------------------
	const brandLabel = (b) => BRANDS[b]?.label || b;
	const formatLabel = (f) => FORMATS[f]?.label || "General";

	// "✅ Asunto 32/50 · ⚠️ Preheader 95/90"
	function limitsLine(opt) {
		const parts = (opt.fields || [])
			.filter((f) => f.max || f.firstLineMax)
			.map((f) => {
				const name = opt.fields.length > 1 ? `${f.label} ` : "";
				if (f.firstLineMax && !f.max) {
					return `${f.firstLineLength <= f.firstLineMax ? "✅" : "⚠️"} ${name}1ª línea ${f.firstLineLength}/${f.firstLineMax}`;
				}
				return `${f.ok ? "✅" : "⚠️"} ${name}${f.length}/${f.max}`;
			});
		return parts.join(" · ");
	}

	function referencesLine(brand, refs) {
		if (!refs?.count) return null;
		const kind = refs.method === "embeddings" ? "ejemplos reales parecidos" : "ejemplos reales al azar";
		const top = refs.top ? ` · el más cercano: “${esc(truncate(refs.top.replace(/\s+/g, " "), 110))}”` : "";
		const winners = refs.topPerformers ? ` (${refs.topPerformers} ★ de los que mejor funcionaron en anuncios)` : "";
		return `📚 Inspirado en ${refs.count} ${kind} de ${brandLabel(brand)}${winners}${top}`;
	}

	function resultBlocks({ action, brand, format, options, references, corrected, original, prompt }) {
		const blocks = [];
		const meta =
			action === "ortografia"
				? `${ACTION_LABELS.ortografia} · ${brandLabel(brand)}`
				: `${ACTION_LABELS[action]} · ${brandLabel(brand)} · ${formatLabel(format)}`;
		blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: meta }] });
		const refLine = action !== "ortografia" ? referencesLine(brand, references) : null;
		if (refLine) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: refLine }] });

		if (action === "ortografia") {
			const same = corrected.trim() === String(original || "").trim();
			blocks.push({
				type: "section",
				text: { type: "mrkdwn", text: same ? "✅ No encontré errores." : "*Texto corregido:*" },
			});
			if (!same) blocks.push({ type: "section", text: { type: "plain_text", text: truncate(corrected, 2900) } });
			return blocks;
		}

		if (!options.length) {
			blocks.push({ type: "section", text: { type: "mrkdwn", text: "No obtuve opciones esta vez. Prueba con “Otra tanda”." } });
		}
		options.forEach((opt, i) => {
			blocks.push({ type: "divider" });
			blocks.push({
				type: "section",
				block_id: `opt_${i}`,
				text: { type: "mrkdwn", text: `*Opción ${i + 1}*${opt.angleLabel ? `  ·  ${opt.angleLabel}` : ""}\n${optionBody(opt)}` },
			});
			const notes = [];
			const limits = limitsLine(opt);
			if (limits) notes.push(limits);
			const banned = storage?.glossaryViolations?.(brand, opt.text) || [];
			if (banned.length) notes.push(`⚠️ Glosario: ${banned.map((w) => `“${esc(w)}”`).join(", ")}`);
			if (notes.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: notes.join("   ") }] });
			const val = (rating) =>
				JSON.stringify({ r: rating, b: brand, s: action === "reescribir" ? "reescribir" : "crear", t: truncate(opt.text, 1800) });
			blocks.push({
				type: "actions",
				block_id: `rate_${i}`,
				elements: [
					{ type: "button", action_id: `like_${i}`, text: { type: "plain_text", text: "👍 Me encanta", emoji: true }, value: val("like") },
					{ type: "button", action_id: `neutral_${i}`, text: { type: "plain_text", text: "⚪ Sirve con ajustes", emoji: true }, value: val("neutral") },
					{ type: "button", action_id: `dislike_${i}`, text: { type: "plain_text", text: "👎 No va", emoji: true }, value: val("bad") },
					{
						type: "button",
						action_id: `figma_${i}`,
						text: { type: "plain_text", text: "📤 A Figma", emoji: true },
						value: JSON.stringify({ b: brand, f: format, t: truncate(opt.text, 1800) }),
					},
				],
			});
		});

		// Botones finales: otra tanda y cambiar de marca (re-ejecutan la misma petición).
		const base = { a: action, f: format, p: truncate(prompt, 1500) };
		const other = Object.keys(BRANDS).find((b) => b !== brand);
		const retry = [
			{
				type: "button",
				action_id: "retry",
				text: { type: "plain_text", text: "🔄 Otra tanda", emoji: true },
				value: JSON.stringify({ ...base, b: brand }),
			},
		];
		if (other) {
			retry.push({
				type: "button",
				action_id: "retry_brand",
				text: { type: "plain_text", text: `Probar con ${brandLabel(other)}` },
				value: JSON.stringify({ ...base, b: other }),
			});
		}
		blocks.push({ type: "divider" }, { type: "actions", block_id: "retry", elements: retry });
		return blocks;
	}

	function optionBody(opt) {
		const fields = opt.fields || [];
		if (fields.length > 1) return fields.map((f) => `*${f.label}:* ${esc(truncate(f.value, 1200))}`).join("\n");
		return esc(truncate(opt.text, 2800));
	}

	// Texto de respaldo (notificaciones y contexto del hilo para el router).
	function fallbackText({ action, options, corrected }) {
		if (action === "ortografia") return `Texto corregido:\n${corrected}`;
		return options.map((o, i) => `${i + 1}. ${o.text}`).join("\n") || "Sin opciones";
	}

	async function usageBlocks(days) {
		const u = await computeUsageSummary(days);
		const f = await computeFeedbackSummary();
		const period = Number(days) > 0 ? `últimos ${days} días` : "histórico";
		const endpoints = Object.entries(u.byEndpoint)
			.sort((a, b) => b[1].requests - a[1].requests)
			.map(([k, v]) => `• \`${k}\`: ${v.requests} req · $${v.estimatedCostUsd.toFixed(3)}`)
			.join("\n");
		const fb = Object.entries(f.byBrand)
			.map(([b, v]) => `• ${brandLabel(b)}: 👍 ${v.like || 0} · ⚪ ${v.neutral || 0} · ✖️ ${v.bad || 0}`)
			.join("\n");
		return [
			{ type: "header", text: { type: "plain_text", text: `📊 Uso de Topito (${period})` } },
			{
				type: "section",
				fields: [
					{ type: "mrkdwn", text: `*Peticiones*\n${u.requests}` },
					{ type: "mrkdwn", text: `*Costo estimado*\n$${u.totalEstimatedCostUsd.toFixed(2)} USD` },
					{ type: "mrkdwn", text: `*Tokens entrada*\n${u.totalInputTokens.toLocaleString("es-MX")}` },
					{ type: "mrkdwn", text: `*Tokens salida*\n${u.totalOutputTokens.toLocaleString("es-MX")}` },
				],
			},
			{ type: "section", text: { type: "mrkdwn", text: `*Por servicio*\n${endpoints || "Sin datos"}` } },
			{ type: "section", text: { type: "mrkdwn", text: `*Calificaciones*\n${fb || "Sin datos"}` } },
		];
	}

	const HELP_TEXT = `Hola, soy *Topito* ✍️ — tu asistente de copy para ${Object.values(BRANDS)
		.map((b) => b.label)
		.join(" y ")}. Háblame normal, por ejemplo:
• _Escribe 3 headlines para la colección de lentes de sol_
• _Reescribe con nuestro tono este caption: …_
• _Asunto y preheader para el email de la colección_ · _4 títulos de Google Ads para lentes de sol_ · _hooks para un Reel_
• _Revisa la ortografía de: …_
• _Ahora hazlo para Bombavista_ / _más corto_ (en el mismo hilo)
• _Reporte de uso de los últimos 7 días_
También puedes usar el menú ⋯ de cualquier mensaje → *Reescribir con Topito* o *Revisar ortografía*, o reaccionar con 🔤 (ortografía) o 🔁 (reescribir).
Pega un link de Google Docs/Sheets con un brief o una lista de copies y los trabajo. Con *📤 A Figma* la opción llega a tu plugin.
Califica las opciones con 👍 / ⚪ — así aprendo el tono del equipo.`;

	// ---------------------------------------------------------------------------
	// "Respondedor": publica un placeholder y luego lo reemplaza con el resultado
	// ---------------------------------------------------------------------------
	async function startReply({ channel, thread_ts }) {
		const placeholder = await slack("chat.postMessage", {
			channel,
			thread_ts,
			text: "✍️ Topito está escribiendo…",
		});
		// Ojo: si "channel" es un ID de usuario (resultados por DM), Slack publica en
		// el DM pero chat.update exige el ID real del canal (D...). Por eso usamos
		// placeholder.channel. Si aun así falla la edición, publicamos un mensaje
		// nuevo para que el placeholder nunca se quede "escribiendo…".
		const realChannel = placeholder.channel || channel;
		return {
			update: async (text, blocks) => {
				try {
					return await slack("chat.update", { channel: realChannel, ts: placeholder.ts, text, blocks: blocks || undefined });
				} catch (err) {
					console.error("[slack] chat.update falló, publico mensaje nuevo:", err.details ?? err);
					slack("chat.delete", { channel: realChannel, ts: placeholder.ts }).catch(() => {});
					return slack("chat.postMessage", { channel: realChannel, thread_ts, text, blocks: blocks || undefined });
				}
			},
		};
	}

	// Procesa una petición de copy (desde mención, DM, botón o modal) y responde.
	async function processCopyRequest({ userId, channel, thread_ts, action, text, brand, format }) {
		const reply = await startReply({ channel, thread_ts });
		if (!checkRateLimit(userId)) {
			return reply.update(`🚦 Llegaste al límite de ${RATE_LIMIT} peticiones cada 10 minutos. Intenta en un rato.`);
		}
		try {
			const result = await runCopyAction({ action, text, brand, format });
			const payload = { action, brand, format, original: text, prompt: text, ...result };
			await reply.update(fallbackText(payload), resultBlocks(payload));
		} catch (err) {
			console.error("[slack] Error en processCopyRequest:", err.details ?? err);
			await reply.update(friendlyError(err));
		}
	}

	// Lee el hilo para darle contexto al router (solo si el mensaje está en un hilo).
	async function getThreadHistory(channel, thread_ts, currentTs, botUserId) {
		try {
			const { messages = [] } = await slack("conversations.replies", { channel, ts: thread_ts, limit: 30 });
			return messages
				.filter((m) => m.ts !== currentTs && m.text && !m.text.startsWith("✍️ Topito está escribiendo"))
				.slice(-12)
				.map((m) => {
					const who = m.bot_id || m.user === botUserId ? "Topito" : "Usuario";
					return `${who}: ${truncate(m.text.replace(/<@[A-Z0-9]+>/g, "").trim(), 1500)}`;
				});
		} catch (err) {
			console.error("[slack] conversations.replies falló:", err.details ?? err);
			return [];
		}
	}

	// ---------------------------------------------------------------------------
	// Fase 3: lote (lista de copies de un Doc/Sheet), lectura de documentos,
	// reacciones 🔤/🔁, modo asistente y resumen semanal
	// ---------------------------------------------------------------------------
	const DOC_URL_RE = /https:\/\/docs\.google\.com\/(?:document|spreadsheets)\/d\/[\w-]+[^\s|>]*/;
	const MAX_LOTE = 10;

	async function processLote({ userId, channel, thread_ts, items, brand, format }) {
		const reply = await startReply({ channel, thread_ts });
		const list = items.map((t) => String(t || "").trim()).filter(Boolean);
		const truncatedNote = list.length > MAX_LOTE ? `\n_(Tomé los primeros ${MAX_LOTE} de ${list.length}.)_` : "";
		const work = list.slice(0, MAX_LOTE);
		if (!work.length) return reply.update("No encontré copies en el documento. ¿Me dices cuáles quieres entonar?");
		if (!checkRateLimit(userId)) {
			return reply.update(`🚦 Llegaste al límite de ${RATE_LIMIT} peticiones cada 10 minutos. Intenta en un rato.`);
		}
		try {
			// De 3 en 3 para no saturar la API.
			const results = [];
			for (let i = 0; i < work.length; i += 3) {
				const chunk = work.slice(i, i + 3);
				results.push(...(await Promise.all(chunk.map((text) => reescribirCore({ prompt: text, brand, format }).catch(() => null)))));
			}
			const blocks = [
				{
					type: "context",
					elements: [{ type: "mrkdwn", text: `🔁 Lote · ${brandLabel(brand)} · ${formatLabel(format)} · ${work.length} copies${truncatedNote}` }],
				},
			];
			work.forEach((original, n) => {
				blocks.push({ type: "divider" });
				blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `*${n + 1}. Original:* ${esc(truncate(original, 280))}` }] });
				const opts = results[n]?.options?.slice(0, 2) || [];
				if (!opts.length) {
					blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No pude reescribir este, intenta de nuevo._" } });
					return;
				}
				opts.forEach((opt, j) => {
					const limits = limitsLine(opt);
					blocks.push({
						type: "section",
						text: { type: "mrkdwn", text: `${esc(truncate(opt.text, 2600))}${limits ? `\n_${limits}_` : ""}` },
						accessory: {
							type: "button",
							action_id: `like_l${n}x${j}`,
							text: { type: "plain_text", text: "👍", emoji: true },
							value: JSON.stringify({ r: "like", b: brand, s: "reescribir", t: truncate(opt.text, 1800) }),
						},
					});
				});
			});
			const text = work.map((o, n) => `${n + 1}. ${results[n]?.options?.[0]?.text || "(sin resultado)"}`).join("\n");
			await reply.update(text, blocks);
		} catch (err) {
			console.error("[slack] Error en lote:", err.details ?? err);
			await reply.update(friendlyError(err));
		}
	}

	// Si el mensaje trae un link de Google Docs/Sheets, agrega su contenido al
	// mensaje para el router. La verificación de acceso la hace el Apps Script.
	async function withDocContent(message, userId) {
		const match = message.match(DOC_URL_RE);
		if (!match || !storage?.readDoc) return { message };
		try {
			const doc = await storage.readDoc(match[0], getUserEmail(userId));
			const content = truncate(String(doc.text || ""), 8000);
			return {
				message: `${message.replace(match[0], "(link al documento)")}\n\n[Contenido del documento "${doc.title || ""}"]\n${content}`,
				docTitle: doc.title,
			};
		} catch (err) {
			const denied = /sin acceso|no tienes acceso|denied/i.test(err.message);
			return {
				error: denied
					? "🔒 No tienes acceso a ese documento (o no está compartido con Ben & Frank), así que no lo puedo leer."
					: "😕 No pude abrir ese documento. Revisa que el link sea de Google Docs o Sheets y que esté compartido con Ben & Frank.",
			};
		}
	}

	async function fetchMessage(channel, ts) {
		try {
			const h = await slack("conversations.history", { channel, latest: ts, oldest: ts, inclusive: true, limit: 1 });
			if (h.messages?.[0]?.ts === ts) return h.messages[0];
		} catch {}
		try {
			const r = await slack("conversations.replies", { channel, ts, limit: 50 });
			return (r.messages || []).find((m) => m.ts === ts) || null;
		} catch {
			return null;
		}
	}

	// 🔤 (:abc:) = ortografía · 🔁 (:repeat:) = reescribir con el tono de la marca
	const REACTION_ACTIONS = { abc: "ortografia", repeat: "reescribir" };

	async function handleReaction(event) {
		const action = REACTION_ACTIONS[event.reaction];
		if (!action || event.item?.type !== "message") return;
		const botUserId = await getBotUserId();
		if (event.item_user === botUserId || event.user === botUserId) return;
		const key = `reaction:${event.item.channel}:${event.item.ts}:${event.reaction}`;
		if (seenEvents.get(key)) return;
		seenEvents.set(key, true);
		if (!(await isAllowedUser(event.user))) return;

		const msg = await fetchMessage(event.item.channel, event.item.ts);
		const text = (msg?.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
		if (!msg || !text || msg.bot_id) return;
		return processCopyRequest({
			userId: event.user,
			channel: event.item.channel,
			thread_ts: msg.thread_ts || msg.ts,
			action,
			text,
			brand: getBrand(event.user),
			format: "general",
		});
	}

	async function handleAssistantThreadStarted(event) {
		const t = event.assistant_thread || {};
		if (!t.channel_id || !t.thread_ts) return;
		await slack("assistant.threads.setSuggestedPrompts", {
			channel_id: t.channel_id,
			thread_ts: t.thread_ts,
			title: "¿Qué escribimos hoy?",
			prompts: [
				{ title: "Captions para redes", message: "Escribe captions para la nueva colección de lentes de sol" },
				{ title: "Asunto de email", message: "Asunto y preheader para el email de la colección de otoño" },
				{ title: "Google Ads", message: "4 títulos de Google Ads para armazones graduados" },
				{ title: "Revisar ortografía", message: "Revisa la ortografía de: " },
			],
		}).catch((err) => console.error("[slack] setSuggestedPrompts:", err.details ?? err));
	}

	async function digestBlocks() {
		const u = await computeUsageSummary(7);
		const likes = (await storage?.loadRecentLikes?.(7, 50).catch(() => [])) || [];
		const kb = knowledgeStats ? knowledgeStats() : {};
		const likesBy = {};
		for (const l of likes) likesBy[l.brand] = (likesBy[l.brand] || 0) + 1;
		const top = likes.slice(0, 5).map((l) => `• _${esc(truncate(l.text.replace(/\s+/g, " "), 160))}_ — ${brandLabel(l.brand)}${l.author ? ` · ${esc(l.author.split("@")[0])}` : ""}`);
		const kbLine = Object.entries(kb)
			.map(
				([b, v]) =>
					`• ${brandLabel(b)}: ${v.examples.toLocaleString("es-MX")} ejemplos (${v.embeddings.toLocaleString("es-MX")} con búsqueda por parecido` +
					`${v.withPerformance ? `, ${v.withPerformance.toLocaleString("es-MX")} con desempeño real · ${v.topPerformers} ★` : ""})`,
			)
			.join("\n");
		// Copys de Topito que terminaron en anuncios, con su desempeño (score 0..1 = percentil).
		const pub = topitoPublished ? topitoPublished() : null;
		const pubLines = (pub?.matches || [])
			.slice(0, 5)
			.map(
				(m) =>
					`• _${esc(truncate(m.adText.replace(/\s+/g, " "), 140))}_ — ${brandLabel(m.brand)} · CTR ${(m.ctr * 100).toFixed(2)}% · ` +
					`${m.score >= 0.8 ? "★ top" : m.score >= 0.5 ? "arriba de la mediana" : "abajo de la mediana"}`,
			);
		return [
			{ type: "header", text: { type: "plain_text", text: "📊 Topito — resumen de la semana" } },
			{
				type: "section",
				fields: [
					{ type: "mrkdwn", text: `*Peticiones*\n${u.requests}` },
					{ type: "mrkdwn", text: `*Costo estimado*\n$${u.totalEstimatedCostUsd.toFixed(2)} USD` },
					{ type: "mrkdwn", text: `*👍 nuevos*\n${Object.entries(likesBy).map(([b, n]) => `${brandLabel(b)}: ${n}`).join(" · ") || "0"}` },
				],
			},
			{ type: "section", text: { type: "mrkdwn", text: `*Copys favoritos de la semana*\n${top.join("\n") || "_Aún no hay 👍 esta semana._"}` } },
			...(kbLine ? [{ type: "section", text: { type: "mrkdwn", text: `*Base de conocimiento*\n${kbLine}` } }] : []),
			...(pub
				? [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `*Copys de Topito que ya están en anuncios* (${pub.matches.length})\n${pubLines.join("\n") || "_Todavía no detecto ninguno. Se compara contra los 👍/⚪ y la bandeja de Figma._"}`,
							},
						},
					]
				: []),
			{ type: "context", elements: [{ type: "mrkdwn", text: "Califica con 👍 las opciones que te gusten: así Topito aprende el tono del equipo." }] },
		];
	}

	// Lo llama el workflow semanal de GitHub Actions (header X-Topito-Secret).
	app.post("/slack/digest", async (req, res) => {
		if (!requireInternalSecret(req, res)) return;
		const channel = req.body?.channel || process.env.SLACK_DIGEST_CHANNEL;
		if (!channel) return res.status(400).json({ error: "Falta SLACK_DIGEST_CHANNEL." });
		try {
			await slack("chat.postMessage", { channel, text: "Topito — resumen de la semana", blocks: await digestBlocks() });
			res.json({ ok: true });
		} catch (err) {
			console.error("[slack] digest:", err.details ?? err);
			res.status(500).json({ error: err.message });
		}
	});

	// Aviso de fallas (lo llama el workflow diario de GitHub solo si algo salió mal).
	// Publica en SLACK_DIGEST_CHANNEL y menciona a los admins para que llegue notificación.
	app.post("/slack/alert", async (req, res) => {
		if (!requireInternalSecret(req, res)) return;
		const channel = process.env.SLACK_DIGEST_CHANNEL;
		if (!channel) return res.status(400).json({ error: "Falta SLACK_DIGEST_CHANNEL." });
		const text = String(req.body?.text || "Algo falló en un proceso automático de Topito.").slice(0, 2500);
		const mentions = ADMIN_IDS.map((id) => `<@${id}>`).join(" ");
		try {
			await slack("chat.postMessage", {
				channel,
				text: `⚠️ ${mentions ? mentions + " " : ""}${text}`,
				unfurl_links: false,
			});
			res.json({ ok: true });
		} catch (err) {
			console.error("[slack] alert:", err.details ?? err);
			res.status(500).json({ error: err.message });
		}
	});

	// ---------------------------------------------------------------------------
	// Eventos: menciones y DMs
	// ---------------------------------------------------------------------------
	async function handleMessageEvent(event) {
		const botUserId = await getBotUserId();
		// Anti-bucles: nada de bots (incluido Topito), ediciones ni subtipos.
		if (event.bot_id || event.subtype || !event.user || event.user === botUserId) return;
		const dedupeKey = `${event.channel}:${event.ts}`;
		if (seenEvents.get(dedupeKey)) return; // una mención en DM puede llegar dos veces
		seenEvents.set(dedupeKey, true);

		const channel = event.channel;
		const thread_ts = event.thread_ts || event.ts;
		const message = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();

		if (!(await isAllowedUser(event.user))) {
			await slack("chat.postEphemeral", {
				channel,
				user: event.user,
				text: `🔒 Topito solo está disponible para cuentas @${ALLOWED_EMAIL_DOMAIN}.`,
			});
			return;
		}
		if (!message) {
			await slack("chat.postMessage", { channel, thread_ts, text: HELP_TEXT });
			return;
		}

		const history = event.thread_ts ? await getThreadHistory(channel, event.thread_ts, event.ts, botUserId) : [];
		const doc = await withDocContent(message, event.user);
		if (doc.error) return slack("chat.postMessage", { channel, thread_ts, text: doc.error });
		let route;
		try {
			route = await routeRequest({ message: doc.message, history, currentBrand: getBrand(event.user) });
		} catch (err) {
			console.error("[slack] Router falló:", err.details ?? err);
			await slack("chat.postMessage", { channel, thread_ts, text: friendlyError(err) });
			return;
		}

		if (route.brand && BRANDS[route.brand]) setBrand(event.user, route.brand);
		const brand = getBrand(event.user);
		const format = FORMATS[route.format] ? route.format : "general";

		switch (route.action) {
			case "crear":
			case "reescribir":
			case "ortografia": {
				const text = (route.text || message).trim();
				return processCopyRequest({ userId: event.user, channel, thread_ts, action: route.action, text, brand, format });
			}
			case "lote":
				return processLote({ userId: event.user, channel, thread_ts, items: route.items || [], brand, format });
			case "reporte_uso": {
				if (ADMIN_IDS.length && !ADMIN_IDS.includes(event.user)) {
					return slack("chat.postMessage", { channel, thread_ts, text: "🔒 El reporte de uso solo está disponible para admins de Topito." });
				}
				return slack("chat.postMessage", { channel, thread_ts, text: "Reporte de uso de Topito", blocks: await usageBlocks(route.days) });
			}
			case "ayuda":
				return slack("chat.postMessage", { channel, thread_ts, text: HELP_TEXT });
			default:
				return slack("chat.postMessage", { channel, thread_ts, text: route.reply || HELP_TEXT });
		}
	}

	app.post("/slack/events", (req, res) => {
		if (!verifySlackSignature(req)) return res.status(401).send("invalid signature");
		const body = req.body || {};
		if (body.type === "url_verification") return res.json({ challenge: body.challenge });

		// Respondemos YA: Slack reintenta si no recibe 200 en 3 s.
		res.sendStatus(200);
		if (req.headers["x-slack-retry-num"]) return; // reintento de algo que ya estamos procesando
		if (ALLOWED_TEAM_ID && body.team_id !== ALLOWED_TEAM_ID) return;
		if (body.event_id) {
			if (seenEvents.get(body.event_id)) return;
			seenEvents.set(body.event_id, true);
		}

		const event = body.event || {};
		if (event.type === "reaction_added") {
			handleReaction(event).catch((err) => console.error("[slack] Error en reacción:", err.details ?? err));
			return;
		}
		if (event.type === "assistant_thread_started") {
			handleAssistantThreadStarted(event).catch(() => {});
			return;
		}
		const isMention = event.type === "app_mention";
		const isDM = event.type === "message" && event.channel_type === "im";
		if (isMention || isDM) {
			handleMessageEvent(event).catch((err) => console.error("[slack] Error manejando evento:", err.details ?? err));
		}
	});

	// ---------------------------------------------------------------------------
	// Interactividad: botones, atajos de mensaje y modal
	// ---------------------------------------------------------------------------
	function reescribirModal({ text, brand, meta }) {
		const option = (value, label) => ({ text: { type: "plain_text", text: label }, value });
		const brandOptions = Object.entries(BRANDS).map(([k, v]) => option(k, v.label));
		const formatOptions = Object.entries(FORMATS).map(([k, v]) => option(k, v.label));
		return {
			type: "modal",
			callback_id: "topito_reescribir_submit",
			private_metadata: JSON.stringify(meta),
			title: { type: "plain_text", text: "Reescribir con Topito" },
			submit: { type: "plain_text", text: "Reescribir" },
			close: { type: "plain_text", text: "Cancelar" },
			blocks: [
				{
					type: "input",
					block_id: "brand",
					label: { type: "plain_text", text: "Marca" },
					element: {
						type: "static_select",
						action_id: "v",
						options: brandOptions,
						initial_option: brandOptions.find((o) => o.value === brand),
					},
				},
				{
					type: "input",
					block_id: "format",
					label: { type: "plain_text", text: "Formato / canal" },
					element: { type: "static_select", action_id: "v", options: formatOptions, initial_option: formatOptions[0] },
				},
				{
					type: "input",
					block_id: "text",
					label: { type: "plain_text", text: "Texto a reescribir" },
					element: { type: "plain_text_input", action_id: "v", multiline: true, initial_value: truncate(text, 2900) },
				},
			],
		};
	}

	async function handleInteraction(payload) {
		const userId = payload.user?.id;

		// --- Atajos de mensaje (menú ⋯) ---
		if (payload.type === "message_action") {
			if (!(await isAllowedUser(userId))) {
				return postToResponseUrl(payload.response_url, {
					response_type: "ephemeral",
					text: `🔒 Topito solo está disponible para cuentas @${ALLOWED_EMAIL_DOMAIN}.`,
				});
			}
			const text = (payload.message?.text || "").trim();
			if (!text) {
				return postToResponseUrl(payload.response_url, { response_type: "ephemeral", text: "Ese mensaje no tiene texto que pueda procesar." });
			}
			if (payload.callback_id === "topito_reescribir") {
				return slack("views.open", {
					trigger_id: payload.trigger_id,
					view: reescribirModal({ text, brand: getBrand(userId), meta: { response_url: payload.response_url } }),
				});
			}
			if (payload.callback_id === "topito_ortografia") {
				// Resultado por DM (persistente) + aviso efímero en el canal.
				await postToResponseUrl(payload.response_url, { response_type: "ephemeral", text: "🔤 Revisando ortografía… te mando el resultado por DM." });
				return processCopyRequest({ userId, channel: userId, action: "ortografia", text, brand: getBrand(userId), format: "general" });
			}
			return;
		}

		// --- Envío del modal de "Reescribir con Topito" ---
		if (payload.type === "view_submission" && payload.view?.callback_id === "topito_reescribir_submit") {
			const v = payload.view.state.values;
			const brand = v.brand.v.selected_option?.value || getBrand(userId);
			const format = v.format.v.selected_option?.value || "general";
			const text = v.text.v.value || "";
			const meta = JSON.parse(payload.view.private_metadata || "{}");
			setBrand(userId, brand);
			if (meta.response_url) {
				postToResponseUrl(meta.response_url, { response_type: "ephemeral", text: "🔁 Reescribiendo… te mando las opciones por DM." }).catch(() => {});
			}
			return processCopyRequest({ userId, channel: userId, action: "reescribir", text, brand, format });
		}

		// --- Botones ---
		if (payload.type === "block_actions") {
			const act = payload.actions?.[0];
			if (!act) return;
			// En canales compartidos cualquiera ve los botones: validamos también aquí.
			if (!(await isAllowedUser(userId))) return;
			const channel = payload.channel?.id || payload.container?.channel_id;
			const message = payload.message;

			if (/^figma_\d+$/.test(act.action_id)) {
				const { b, f, t } = JSON.parse(act.value);
				const email = getUserEmail(userId);
				let ok = false;
				try {
					ok = email ? await storage?.addFigmaInbox?.({ email, brand: BRANDS[b] ? b : DEFAULT_BRAND, format: f || "general", text: t }) : false;
				} catch (err) {
					console.error("[slack] addFigmaInbox:", err.message);
				}
				if (payload.response_url) {
					await postToResponseUrl(payload.response_url, {
						response_type: "ephemeral",
						replace_original: false,
						text: ok
							? "📤 Listo: quedó en tu bandeja *Desde Slack* del plugin de Figma (abre Topito Writer con tu correo de Ben & Frank)."
							: "😕 No pude mandarlo a Figma en este momento.",
					});
				}
				return;
			}

			if (/^(like|neutral|dislike)_\w+$/.test(act.action_id)) {
				const { r, b, s: rawSource, t } = JSON.parse(act.value);
				const idx = act.action_id.split("_")[1];
				// 👎 explícito: se marca para distinguirlo del "bad" automático (ver storage.loadDislikes).
				const s = r === "bad" ? `${rawSource}-explicito` : rawSource;
				saveFeedback({ text: t, rating: r, source: s, brand: BRANDS[b] ? b : DEFAULT_BRAND, original: null, author: getUserEmail(userId), channel: "slack" });
				if (message?.blocks && payload.response_url) {
					// Reemplazamos los botones de esa opción por la calificación.
					const label = `${r === "like" ? "👍 Me encanta" : r === "bad" ? "👎 No va (Topito evitará algo así)" : "⚪ Sirve con ajustes"} — <@${userId}>`;
					const blocks = message.blocks.map((blk) => {
						if (blk.block_id === `rate_${idx}`) {
							return { type: "context", block_id: `rated_${idx}`, elements: [{ type: "mrkdwn", text: label }] };
						}
						if (blk.accessory?.action_id === act.action_id) {
							const { accessory, ...rest } = blk;
							return { ...rest, text: { ...blk.text, text: `${blk.text.text}\n${label}` } };
						}
						return blk;
					});
					return postToResponseUrl(payload.response_url, { replace_original: true, text: message.text, blocks });
				}
				return;
			}

			if (act.action_id === "retry" || act.action_id === "retry_brand") {
				const { a, b, f, p } = JSON.parse(act.value);
				const brand = BRANDS[b] ? b : getBrand(userId);
				// Igual que en el plugin: pedir otra tanda sin calificar = esas opciones "no sirvieron".
				if (message?.blocks && act.action_id === "retry") {
					for (const blk of message.blocks) {
						if (blk.type === "actions" && /^rate_\d+$/.test(blk.block_id || "")) {
							try {
								const { b: ob, s, t } = JSON.parse(blk.elements[0].value);
								saveFeedback({ text: t, rating: "bad", source: s, brand: BRANDS[ob] ? ob : DEFAULT_BRAND, original: null, author: getUserEmail(userId), channel: "slack" });
							} catch {}
						}
					}
				}
				if (message?.blocks && payload.response_url) {
					const note = act.action_id === "retry" ? "🔄 Pediste otra tanda" : `🔄 Pediste versión para ${brandLabel(brand)}`;
					const blocks = message.blocks.map((blk) =>
						blk.block_id === "retry" ? { type: "context", block_id: "retried", elements: [{ type: "mrkdwn", text: `${note} — <@${userId}>` }] } : blk,
					);
					await postToResponseUrl(payload.response_url, { replace_original: true, text: message.text, blocks }).catch(() => {});
				}
				if (act.action_id === "retry_brand") setBrand(userId, brand);
				const thread_ts = message?.thread_ts || message?.ts;
				return processCopyRequest({ userId, channel: channel || userId, thread_ts, action: a, text: p, brand, format: f });
			}
		}
	}

	app.post("/slack/interactions", (req, res) => {
		if (!verifySlackSignature(req)) return res.status(401).send("invalid signature");
		let payload;
		try {
			payload = JSON.parse(req.body?.payload || "{}");
		} catch {
			return res.status(400).send("bad payload");
		}
		if (ALLOWED_TEAM_ID && payload.team?.id !== ALLOWED_TEAM_ID) return res.sendStatus(200);
		res.status(200).send(""); // ack inmediato (también cierra el modal en view_submission)
		handleInteraction(payload).catch((err) => console.error("[slack] Error en interacción:", err.details ?? err));
	});
}
