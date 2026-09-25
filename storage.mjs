// =============================================================================
// Persistencia de Topito (sin dependencias extra):
//   • Supabase (Postgres vía REST/PostgREST) = fuente de verdad: uso, feedback,
//     banco de copys (👍), preferencias de Slack y bandeja de Figma.
//   • Google Sheets (vía Apps Script) = espejo del banco de copys para Content
//     + pestaña "Glosario" que Content edita (términos preferidos/prohibidos).
//
// Todo es opcional: si faltan las variables, cada parte se apaga sola y el
// server sigue funcionando con los archivos locales como antes.
//
// Variables:
//   SUPABASE_URL                  https://<ref>.supabase.co
//   SUPABASE_SERVICE_KEY          service_role key (SOLO en el server; nunca en el plugin)
//   TOPITO_SHEET_WEBHOOK_URL      URL /exec del Apps Script del Sheet (apps-script/Code.gs)
//   TOPITO_SHEET_SECRET           secreto compartido con ese Apps Script
// =============================================================================

const GLOSSARY_REFRESH_MS = 5 * 60 * 1000;

export function createStorage({ fetchWithTimeout }) {
	const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
	const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
	const dbEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

	// Puente con Google Sheets: un Apps Script dentro del Sheet publicado como web
	// app (ver apps-script/Code.gs). Protegido con un secreto compartido.
	const SHEET_URL = process.env.TOPITO_SHEET_WEBHOOK_URL;
	const SHEET_SECRET = process.env.TOPITO_SHEET_SECRET;
	const sheetsEnabled = Boolean(SHEET_URL && SHEET_SECRET);

	console.log(`[storage] Supabase: ${dbEnabled ? "activo" : "desactivado"} · Google Sheets: ${sheetsEnabled ? "activo" : "desactivado"}`);

	// ---------------------------------------------------------------------------
	// Supabase (PostgREST)
	// ---------------------------------------------------------------------------
	async function sb(pathAndQuery, { method = "GET", body, prefer } = {}) {
		const response = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
			method,
			headers: {
				apikey: SUPABASE_KEY,
				// Las llaves nuevas (sb_secret_...) van solo en "apikey"; las legacy (JWT) también en Authorization.
				...(SUPABASE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${SUPABASE_KEY}` } : {}),
				"Content-Type": "application/json",
				...(prefer ? { Prefer: prefer } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Supabase ${method} ${pathAndQuery.split("?")[0]} -> ${response.status}: ${text.slice(0, 300)}`);
		}
		const text = await response.text();
		return text ? JSON.parse(text) : null;
	}

	// Escritura "fire and forget": nunca bloquea ni rompe la respuesta al usuario.
	function insert(table, rows, { onConflict, ignoreDuplicates = false } = {}) {
		if (!dbEnabled) return;
		const q = onConflict ? `${table}?on_conflict=${onConflict}` : table;
		const prefer = ["return=minimal", onConflict ? `resolution=${ignoreDuplicates ? "ignore" : "merge"}-duplicates` : null]
			.filter(Boolean)
			.join(",");
		sb(q, { method: "POST", body: rows, prefer }).catch((err) => console.error("[storage]", err.message));
	}

	// Lee todas las filas (paginando de 1000 en 1000) con filtros PostgREST.
	// Reintenta una vez: un proyecto nuevo de Supabase a veces responde
	// "JWT issued at future" (desfase de reloj) en los primeros segundos.
	async function selectAll(table, query = "") {
		try {
			return await selectAllOnce(table, query);
		} catch (err) {
			await new Promise((r) => setTimeout(r, 3000));
			return selectAllOnce(table, query);
		}
	}

	async function selectAllOnce(table, query = "") {
		const out = [];
		for (let offset = 0; offset < 100_000; offset += 1000) {
			const page = await sb(`${table}?${query}${query ? "&" : ""}limit=1000&offset=${offset}`);
			out.push(...page);
			if (page.length < 1000) break;
		}
		return out;
	}

	// ---------------------------------------------------------------------------
	// Google Sheets vía Apps Script (el web app responde JSON; sigue redirects)
	// ---------------------------------------------------------------------------
	async function sheetCall(action, payload = {}) {
		const response = await fetchWithTimeout(SHEET_URL, {
			method: "POST",
			headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight/validaciones en Apps Script
			body: JSON.stringify({ secret: SHEET_SECRET, action, ...payload }),
			redirect: "follow",
		});
		const data = await response.json().catch(() => ({ ok: false, error: `respuesta no JSON (${response.status})` }));
		if (!data.ok) throw new Error(`Sheet ${action}: ${data.error || response.status}`);
		return data;
	}

	function appendBankRow(values) {
		if (!sheetsEnabled) return;
		sheetCall("appendBank", { row: values }).catch((err) => console.error("[storage]", err.message));
	}

	// ---------------------------------------------------------------------------
	// Glosario (pestaña "Glosario": Marca | Tipo | Término | Nota/Reemplazo)
	//   Marca: benandfrank / bombavista / todas
	//   Tipo:  prohibida | preferida
	// ---------------------------------------------------------------------------
	let glossary = [];
	let glossaryLoadedAt = 0;

	async function refreshGlossary() {
		if (!sheetsEnabled) return;
		try {
			const data = await sheetCall("glossary");
			glossary = (data.rows || [])
				.map(([brand = "", type = "", term = "", note = ""]) => ({
					brand: brand.trim().toLowerCase().replace(/[\s&]/g, ""),
					type: type.trim().toLowerCase().startsWith("prohib") ? "prohibida" : "preferida",
					term: term.trim(),
					note: note.trim(),
				}))
				.filter((g) => g.term);
			glossaryLoadedAt = Date.now();
		} catch (err) {
			console.error("[storage] No se pudo leer el glosario:", err.message);
		}
	}
	if (sheetsEnabled) {
		refreshGlossary();
		setInterval(refreshGlossary, GLOSSARY_REFRESH_MS).unref();
	}

	function glossaryFor(brand) {
		return glossary.filter((g) => !g.brand || g.brand === "todas" || g.brand === brand);
	}

	// Texto para agregar al prompt de reescribir/crear.
	function glossaryPrompt(brand) {
		const items = glossaryFor(brand);
		if (!items.length) return "";
		const forbidden = items.filter((g) => g.type === "prohibida");
		const preferred = items.filter((g) => g.type === "preferida");
		let out = "\nReglas del glosario de la marca (obligatorias):\n";
		if (forbidden.length) {
			out += `- NUNCA uses estas palabras o frases: ${forbidden
				.map((g) => `"${g.term}"${g.note ? ` (usa en su lugar: ${g.note})` : ""}`)
				.join(", ")}.\n`;
		}
		if (preferred.length) {
			out += `- Escribe estos términos exactamente así cuando aparezcan: ${preferred
				.map((g) => `"${g.term}"${g.note ? ` (${g.note})` : ""}`)
				.join(", ")}.\n`;
		}
		return out;
	}

	// Revisa un texto ya generado y regresa las palabras prohibidas que contiene.
	// Palabra/frase completa (no subcadena): "vos" no debe marcar "nuevos".
	const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	function glossaryViolations(brand, text) {
		const t = String(text || "");
		return glossaryFor(brand)
			.filter((g) => g.type === "prohibida" && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(g.term)}($|[^\\p{L}\\p{N}])`, "iu").test(t))
			.map((g) => g.term);
	}

	// ---------------------------------------------------------------------------
	// API de alto nivel usada por server.mjs y slack.mjs
	// ---------------------------------------------------------------------------
	return {
		dbEnabled,
		sheetsEnabled,

		logUsage(entry) {
			insert("usage_log", [
				{
					endpoint: entry.endpoint,
					provider: entry.provider,
					model: entry.model,
					input_tokens: entry.inputTokens || 0,
					output_tokens: entry.outputTokens || 0,
					estimated_cost_usd: entry.estimatedCostUsd ?? null,
				},
			]);
		},

		logFeedback({ text, rating, source, brand, original, author, channel }) {
			insert("feedback", [{ brand, source, rating, text, original: original ?? null, author: author ?? null, channel: channel ?? null }]);
			if (rating === "like") {
				insert(
					"copy_bank",
					[{ brand, source, text, original: original ?? null, author: author ?? null }],
					{ onConflict: "brand,text_hash", ignoreDuplicates: true },
				);
				appendBankRow([
					new Date().toLocaleString("sv-SE", { timeZone: "America/Mexico_City" }).slice(0, 16), // hora CDMX
					brand,
					source,
					text,
					original ?? "",
					author ?? "",
					channel ?? "",
				]);
			}
		},

		// Los 👍 guardados en Supabase, para recargarlos como ejemplos de tono al arrancar.
		async loadLikedCopies() {
			if (!dbEnabled) return [];
			try {
				return await selectAll("copy_bank", "select=brand,text");
			} catch (err) {
				console.error("[storage] No se pudo leer copy_bank:", err.message);
				return [];
			}
		},

		async loadUsage(days) {
			if (!dbEnabled) return null;
			let q = "select=endpoint,provider,input_tokens,output_tokens,estimated_cost_usd,created_at";
			if (Number(days) > 0) q += `&created_at=gte.${new Date(Date.now() - days * 864e5).toISOString()}`;
			const rows = await selectAll("usage_log", q);
			return rows.map((r) => ({
				endpoint: r.endpoint,
				provider: r.provider,
				inputTokens: r.input_tokens,
				outputTokens: r.output_tokens,
				estimatedCostUsd: r.estimated_cost_usd == null ? 0 : Number(r.estimated_cost_usd),
			}));
		},

		async loadFeedback(brand) {
			if (!dbEnabled) return null;
			let q = "select=brand,source,rating";
			if (brand) q += `&brand=eq.${encodeURIComponent(brand)}`;
			return selectAll("feedback", q);
		},

		async loadSlackPrefs() {
			if (!dbEnabled) return null;
			try {
				const rows = await selectAll("slack_prefs", "select=user_id,brand");
				return Object.fromEntries(rows.map((r) => [r.user_id, { brand: r.brand }]));
			} catch (err) {
				console.error("[storage] No se pudo leer slack_prefs:", err.message);
				return null;
			}
		},

		saveSlackPref(userId, brand) {
			insert("slack_prefs", [{ user_id: userId, brand, updated_at: new Date().toISOString() }], { onConflict: "user_id" });
		},

		// --- Fase 3: bandeja "Mandar a Figma" ---
		addFigmaInbox({ email, brand, format, text }) {
			if (!dbEnabled) return Promise.resolve(false);
			return sb("figma_inbox", { method: "POST", body: [{ email, brand, format, text }], prefer: "return=minimal" }).then(() => true);
		},
		async listFigmaInbox(email) {
			if (!dbEnabled) return [];
			return sb(
				`figma_inbox?select=id,created_at,brand,format,text&email=eq.${encodeURIComponent(email)}&consumed_at=is.null&order=id.desc&limit=30`,
			);
		},
		async consumeFigmaInbox(email, id) {
			if (!dbEnabled) return;
			await sb(`figma_inbox?id=eq.${Number(id)}&email=eq.${encodeURIComponent(email)}`, {
				method: "PATCH",
				body: { consumed_at: new Date().toISOString() },
				prefer: "return=minimal",
			});
		},

		// 👎 explícitos (botón "No va" en Slack): se usan como ejemplos a EVITAR.
		// Los "bad" automáticos (pedir otra tanda sin calificar) NO entran: son ruido.
		async loadDislikes(limit = 60) {
			if (!dbEnabled) return [];
			try {
				return await sb(`feedback?select=brand,text&rating=eq.bad&source=like.*-explicito&order=id.desc&limit=${limit}`);
			} catch (err) {
				console.error("[storage] No se pudieron leer los 👎:", err.message);
				return [];
			}
		},

		// Últimos 👍 de una persona (para la pestaña Home de Slack).
		async loadUserLikes(email, limit = 5) {
			if (!dbEnabled || !email) return [];
			try {
				return await sb(
					`feedback?select=brand,text,created_at&rating=eq.like&author=eq.${encodeURIComponent(email)}&order=id.desc&limit=${limit}`,
				);
			} catch {
				return [];
			}
		},

		// --- Fase 3: resumen semanal ---
		async loadRecentLikes(days = 7, limit = 8) {
			if (!dbEnabled) return [];
			const since = new Date(Date.now() - days * 864e5).toISOString();
			return sb(`feedback?select=brand,text,author,channel,created_at&rating=eq.like&created_at=gte.${since}&order=id.desc&limit=${limit}`);
		},

		// --- Fase 3: leer un Google Doc/Sheet que alguien pega en Slack ---
		// El Apps Script corre como Zul, así que ÉL valida que quien lo pide
		// (requester, correo verificado por Slack) tenga acceso al archivo --
		// si no, nadie podría leer por medio de Topito algo que no le compartieron.
		async readDoc(url, requester) {
			if (!sheetsEnabled) throw new Error("La lectura de Docs/Sheets no está configurada.");
			return sheetCall("readDoc", { url, requester });
		},

		glossaryPrompt,
		glossaryViolations,
		glossaryFor,
		refreshGlossary,
		glossaryInfo: () => ({ terms: glossary.length, loadedAt: glossaryLoadedAt || null }),
	};
}
