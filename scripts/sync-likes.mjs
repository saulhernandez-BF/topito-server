// Trae los copys marcados 👍 (tabla copy_bank de Supabase) y los agrega a
// data/<marca>/tuning.json sin duplicar, para que el siguiente
// "npm run build-embeddings" les calcule embedding y entren a la búsqueda por
// relevancia. Lo corre el workflow semanal; si faltan las variables, no hace nada.
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!URL || !KEY) {
	console.log("SUPABASE_URL/SUPABASE_SERVICE_KEY no configurados: se omite sync-likes.");
	process.exit(0);
}

const rows = [];
for (let offset = 0; ; offset += 1000) {
	const res = await fetch(`${URL}/rest/v1/copy_bank?select=brand,text&order=id&limit=1000&offset=${offset}`, {
		headers: { apikey: KEY, ...(KEY.startsWith("eyJ") ? { Authorization: `Bearer ${KEY}` } : {}) },
	});
	if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
	const page = await res.json();
	rows.push(...page);
	if (page.length < 1000) break;
}

const byBrand = {};
for (const { brand, text } of rows) (byBrand[brand] ??= []).push(text);

for (const [brand, texts] of Object.entries(byBrand)) {
	const dir = path.join(__dirname, "..", "data", brand);
	if (!fs.existsSync(dir)) continue; // marca desconocida
	const tuningPath = path.join(dir, "tuning.json");
	let existing = [];
	try {
		existing = JSON.parse(fs.readFileSync(tuningPath, "utf-8"));
	} catch {}
	const known = new Set(existing.map((i) => i.text));
	const fresh = texts.filter((t) => t && !known.has(t));
	if (!fresh.length) continue;
	existing.push(...fresh.map((text) => ({ url: null, source: "feedback-like", text })));
	fs.writeFileSync(tuningPath, JSON.stringify(existing, null, 2));
	console.log(`[${brand}] ${fresh.length} copys 👍 agregados a tuning.json`);
}
console.log("Listo.");
