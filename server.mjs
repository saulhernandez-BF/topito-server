import express from "express";
import fs from "fs";

const app = express();
app.use(express.json());

// Middleware manual de CORS
app.use((req, res, next) => {
	res.header("Access-Control-Allow-Origin", "*"); // permite cualquier origen
	res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") {
		return res.sendStatus(200); // responde al preflight
	}
	next();
});

console.log(
	"GOOGLE_API_KEY:",
	process.env.GOOGLE_API_KEY?.slice(0, 10) + "...",
);

// Carga de referencia
const referenceData = JSON.parse(
	fs.readFileSync(new URL("./bNfWeb_clean.json", import.meta.url), "utf-8"),
);
const referenceText = referenceData.map((item) => item.text).join("\n\n");

app.post("/generate", async (req, res) => {
	try {
		const { prompt } = req.body;

		const fullPrompt = `
Eres un asistente que debe crear textos publicitarios (copy) respetando mi voz y tono.
Aquí tienes ejemplos de mi estilo extraídos de la web:

${referenceText}

Ahora, con base en ese estilo, responde a esta petición:
${prompt}
`;

		const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GOOGLE_API_KEY}`;

		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						parts: [{ text: fullPrompt }],
					},
				],
			}),
		});

		const data = await response.json();

		// Si la API devuelve error, lo mostramos tal cual
		if (data.error) {
			console.error("Error de Gemini:", data.error);
			return res.status(500).json({ error: data.error });
		}

		// Extraemos el texto generado
		const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
		res.json({ text });
	} catch (err) {
		console.error(err);
		res.status(500).json({ error: String(err) });
	}
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
