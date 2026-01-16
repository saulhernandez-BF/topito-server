async function runTest() {
	const res = await fetch("https://topito-server.onrender.com/generate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			prompt: "Haz un copy para invitar a clientes a visitar la tienda",
		}),
	});

	const data = await res.json();
	console.log("Respuesta del server:", data);
}

runTest();
