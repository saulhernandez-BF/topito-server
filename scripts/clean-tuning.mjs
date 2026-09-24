// Limpia data/<marca>/tuning.json: quita páginas legales del sitio y duplicados
// "iguales salvo acentos/emojis/signos", y poda de tuning-embeddings.json los
// vectores de textos que ya no están (así no se gasta cuota de Gemini en basura).
// Correr con: npm run clean-tuning  (el workflow diario lo corre antes de embeddings).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cleanReferenceList } from "../copy-engine.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRANDS = ["benandfrank", "bombavista"];

for (const brand of BRANDS) {
	const dir = path.join(ROOT, "data", brand);
	const tuningPath = path.join(dir, "tuning.json");
	const embPath = path.join(dir, "tuning-embeddings.json");
	if (!fs.existsSync(tuningPath)) continue;

	const before = JSON.parse(fs.readFileSync(tuningPath, "utf-8"));
	const after = cleanReferenceList(before);
	if (after.length !== before.length) {
		fs.writeFileSync(tuningPath, JSON.stringify(after, null, 2));
	}

	let pruned = 0;
	if (fs.existsSync(embPath)) {
		const emb = JSON.parse(fs.readFileSync(embPath, "utf-8"));
		const keep = new Set(after.map((i) => i.text));
		const items = emb.items.filter((i) => keep.has(i.text));
		pruned = emb.items.length - items.length;
		if (pruned) fs.writeFileSync(embPath, JSON.stringify({ ...emb, items }));
	}
	console.log(`[${brand}] ${before.length} → ${after.length} ejemplos (${before.length - after.length} fuera); ${pruned} embeddings podados.`);
}
